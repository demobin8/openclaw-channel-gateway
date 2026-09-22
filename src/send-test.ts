/**
 * Proactive send smoke test (`ocg send` / `POST /ocg/send`).
 *
 * Unit-level coverage of `executeSend` with a mock channel plugin, plus an
 * HTTP-level pass over the real callback server route (signature, disabled,
 * payload limits, CORS preflight).
 *
 * Run: npx tsx src/send-test.ts
 */

import { createHmac } from "node:crypto";
import { executeSend } from "./send-service.js";
import { resolveSendSettings } from "./config.js";
import { getCallbackPort, startCallbackServer, stopCallbackServer } from "./callback-server.js";

// ── Test harness ───────────────────────────────────────────────────────────

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n─── ${title} ───`);
}

/**
 * fetch() with keep-alive disabled: avoids lingering undici sockets that would
 * otherwise delay/abort process teardown on Windows.
 */
function fetchNoKeepAlive(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { connection: "close", ...(init.headers ?? {}) },
  });
}

// ── Mock plugin ────────────────────────────────────────────────────────────

type Call = Record<string, unknown>;

function chunkByLength(text: string, limit: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += limit) out.push(chars.slice(i, i + limit).join(""));
  return out.length > 0 ? out : [""];
}

function createMockPlugin(options: {
  withOutbound?: boolean;
  withSendMedia?: boolean;
  configured?: boolean;
  validateTarget?: boolean;
  sendText?: (ctx: Call, callIndex: number) => Promise<Record<string, unknown>>;
} = {}) {
  const calls: Call[] = [];
  const state = { sanitizeCalls: 0, chunkerCalls: 0, mediaCalls: 0 };
  const {
    withOutbound = true,
    withSendMedia = true,
    configured = true,
    validateTarget = true,
  } = options;

  const plugin: Record<string, unknown> = {
    id: "mock",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (_cfg: unknown, accountId?: string | null) => ({
        accountId: accountId ?? "default",
        enabled: true,
        token: "mock-token",
      }),
      isConfigured: () => configured,
      unconfiguredReason: () => "mock account has no token",
    },
    messaging: {
      targetPrefixes: ["mock"],
      normalizeTarget: (raw: string) => (raw.startsWith("mock:") ? raw : `mock:${raw}`),
      targetResolver: validateTarget
        ? {
            looksLikeId: (raw: string) => /^mock:(c2c|group):[a-z0-9]+$/i.test(raw),
            hint: "mock:c2c:id or mock:group:id",
          }
        : undefined,
    },
  };

  if (withOutbound) {
    plugin.outbound = {
      deliveryMode: "direct",
      chunkerMode: "markdown",
      textChunkLimit: 20,
      chunker: (text: string, limit: number) => {
        state.chunkerCalls += 1;
        return chunkByLength(text, limit);
      },
      sanitizeText: ({ text }: { text: string }) => {
        state.sanitizeCalls += 1;
        return text.trim();
      },
      sendText: async (ctx: Call) => {
        const index = calls.length;
        calls.push(ctx);
        if (options.sendText) return await options.sendText(ctx, index);
        return { channel: "mock", messageId: `m${index + 1}` };
      },
      ...(withSendMedia
        ? {
            sendMedia: async (ctx: Call) => {
              const index = calls.length;
              calls.push(ctx);
              state.mediaCalls += 1;
              return { channel: "mock", messageId: `media${index + 1}` };
            },
          }
        : {}),
    };
  }

  return { plugin, calls, state };
}

const BASE_CFG = { channels: { mock: { enabled: true, token: "mock-token" } } };
const ENABLED = resolveSendSettings({ sendSecret: "test-secret" });
const NO_LOGS = { log: () => {} };

function depsFor(plugin: unknown, loader: unknown = async () => plugin) {
  return {
    ...NO_LOGS,
    getPlugin: () => plugin as never,
    loadPlugin: loader as never,
    now: () => 0,
  };
}

// ── 1. Happy path: sanitize → chunk (plugin chunker) → send ────────────────

section("1. happy path (chunker + sanitizeText + multiple chunks)");
{
  const { plugin, calls, state } = createMockPlugin();
  const text = "A".repeat(45); // limit 20 → 3 chunks
  const outcome = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "mock:c2c:abc123", text },
    deps: depsFor(plugin),
  });

  check("status 200", outcome.httpStatus === 200, outcome);
  check("ok: true", outcome.body.ok === true);
  check("sanitizeText invoked", state.sanitizeCalls === 1, state);
  check("plugin chunker invoked", state.chunkerCalls >= 1, state);
  check("chunks === 3 (textChunkLimit 20)", outcome.body.chunks === 3, outcome.body);
  check("3 sendText calls", calls.length === 3, calls.length);
  check("no text overflow per chunk", calls.every((c) => Array.from(String(c.text)).length <= 20));
  check("messageId from last chunk", outcome.body.messageId === "m3", outcome.body);
  check("target masked in response", outcome.body.to === "mock:c2c:***", outcome.body);
  check("targetValidated true (looksLikeId)", outcome.body.targetValidated === true);
  check("degraded false", outcome.body.degraded === false);
  check("chunksSent === chunksTotal === 3", outcome.body.chunksSent === 3 && outcome.body.chunksTotal === 3);
}

// ── 2. Chunk prefix (opt-in reply-path compatibility) ─────────────────────

section("2. sendChunkPrefix adds [i/n] and keeps the limit");
{
  const { plugin, calls } = createMockPlugin();
  const outcome = await executeSend({
    cfg: BASE_CFG,
    settings: { ...ENABLED, chunkPrefix: true },
    request: { channel: "mock", to: "mock:c2c:abc123", text: "B".repeat(40) },
    deps: depsFor(plugin),
  });

  check("status 200", outcome.httpStatus === 200, outcome);
  check("every chunk starts with [i/n]", calls.every((c, i) => String(c.text).startsWith(`[${i + 1}/${calls.length}]`)), calls.map((c) => c.text));
  check("prefixed chunk fits the declared limit", calls.every((c) => Array.from(String(c.text)).length <= 20), calls.map((c) => String(c.text).length));
}

// ── 3. replyToId only on the first chunk ──────────────────────────────────

section("3. replyToId applies to the first chunk only");
{
  const { plugin, calls } = createMockPlugin();
  await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "mock:group:g1", text: "C".repeat(45), replyToId: "msg-1" },
    deps: depsFor(plugin),
  });

  check("first call carries replyToId", calls[0]?.replyToId === "msg-1", calls[0]);
  check("later calls omit replyToId", calls.slice(1).every((c) => c.replyToId === undefined));
}

// ── 4. Media: sendMedia path + degraded fallback ──────────────────────────

section("4. media delivery (sendMedia + degraded fallback)");
{
  const { plugin, calls, state } = createMockPlugin({ withSendMedia: true });
  const outcome = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: {
      channel: "mock",
      to: "mock:c2c:abc123",
      text: "report",
      mediaUrl: "https://example.com/report.png",
    },
    deps: depsFor(plugin),
  });

  check("status 200", outcome.httpStatus === 200, outcome);
  check("sendMedia called once", state.mediaCalls === 1, state);
  check("media call carries mediaUrl", calls[0]?.mediaUrl === "https://example.com/report.png");
  check("degraded false", outcome.body.degraded === false);
  check("messageId from media call", outcome.body.messageId === "media1", outcome.body);

  const degraded = createMockPlugin({ withSendMedia: false });
  const degradedOutcome = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: {
      channel: "mock",
      to: "mock:c2c:abc123",
      text: "report",
      mediaUrl: "https://example.com/report.png",
    },
    deps: depsFor(degraded.plugin),
  });

  check("fallback status 200", degradedOutcome.httpStatus === 200, degradedOutcome);
  check("degraded: true", degradedOutcome.body.degraded === true, degradedOutcome.body);
  check(
    "link folded into text",
    degraded.calls.map((c) => String(c.text)).join("").includes("https://example.com/report.png"),
    degraded.calls.map((c) => c.text),
  );
}

// ── 5. Target / account / channel validation ──────────────────────────────

section("5. validation (target shape, account, channel, whitelist)");
{
  const { plugin } = createMockPlugin();

  const badTarget = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "totally-wrong", text: "hi" },
    deps: depsFor(plugin),
  });
  check("invalid target → 400 INVALID_TARGET", badTarget.httpStatus === 400 && badTarget.body.code === "INVALID_TARGET", badTarget.body);
  check("hint echoed", badTarget.body.hint === "mock:c2c:id or mock:group:id", badTarget.body);

  const unvalidated = createMockPlugin({ validateTarget: false });
  const noValidation = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "whatever-id", text: "hi" },
    deps: depsFor(unvalidated.plugin),
  });
  check("no declarations → sent, targetValidated false", noValidation.httpStatus === 200 && noValidation.body.targetValidated === false, noValidation.body);

  const unconfigured = createMockPlugin({ configured: false });
  const account = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "mock:c2c:abc123", text: "hi" },
    deps: depsFor(unconfigured.plugin),
  });
  check("unconfigured account → 400 UNKNOWN_ACCOUNT", account.httpStatus === 400 && account.body.code === "UNKNOWN_ACCOUNT", account.body);

  const unknownChannel = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "nope", to: "mock:c2c:abc123", text: "hi" },
    deps: depsFor(plugin),
  });
  check("unknown channel → 404 UNKNOWN_CHANNEL", unknownChannel.httpStatus === 404 && unknownChannel.body.code === "UNKNOWN_CHANNEL", unknownChannel.body);

  const whitelisted = await executeSend({
    cfg: BASE_CFG,
    settings: { ...ENABLED, allowedChannels: ["other"] },
    request: { channel: "mock", to: "mock:c2c:abc123", text: "hi" },
    deps: depsFor(plugin),
  });
  check("whitelist miss → 404 UNKNOWN_CHANNEL", whitelisted.httpStatus === 404 && whitelisted.body.code === "UNKNOWN_CHANNEL", whitelisted.body);

  const missing = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "mock:c2c:abc123", text: "hi" },
    deps: { ...NO_LOGS, getPlugin: () => null, loadPlugin: async () => null },
  });
  check("plugin unavailable → 503 NOT_READY", missing.httpStatus === 503 && missing.body.code === "NOT_READY", missing.body);

  const noOutbound = createMockPlugin({ withOutbound: false });
  const noAdapter = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "mock:c2c:abc123", text: "hi" },
    deps: depsFor(noOutbound.plugin),
  });
  check("no outbound → 501 NO_OUTBOUND_ADAPTER", noAdapter.httpStatus === 501 && noAdapter.body.code === "NO_OUTBOUND_ADAPTER", noAdapter.body);

  const empty = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "mock:c2c:abc123" },
    deps: depsFor(plugin),
  });
  check("no text/media → 400 INVALID_REQUEST", empty.httpStatus === 400 && empty.body.code === "INVALID_REQUEST", empty.body);

  const disabled = await executeSend({
    cfg: BASE_CFG,
    settings: resolveSendSettings({}),
    request: { channel: "mock", to: "mock:c2c:abc123", text: "hi" },
    deps: depsFor(plugin),
  });
  check("no secret → 403 DISABLED", disabled.httpStatus === 403 && disabled.body.code === "DISABLED", disabled.body);
}

// ── 6. Failure detection from return values (D11) ─────────────────────────

section("6. plugin-returned errors, partial failure, timeout");
{
  const failing = createMockPlugin({
    sendText: async () => ({
      channel: "mock",
      messageId: "",
      meta: { error: "11253: 主动消息超出可发送窗口" },
    }),
  });
  const outcome = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "mock:c2c:abc123", text: "hi" },
    deps: depsFor(failing.plugin),
  });
  check("returned error → 502 PLATFORM_SEND_FAILED", outcome.httpStatus === 502 && outcome.body.code === "PLATFORM_SEND_FAILED", outcome.body);
  check("platformCode parsed when present", outcome.body.platformCode === "11253", outcome.body);
  check("partial false", outcome.body.partial === false, outcome.body);

  const partial = createMockPlugin({
    sendText: async (_ctx, index) =>
      index === 1
        ? { channel: "mock", error: "boom" }
        : { channel: "mock", messageId: `ok${index}` },
  });
  const partialOutcome = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "mock:c2c:abc123", text: "D".repeat(45) },
    deps: depsFor(partial.plugin),
  });
  check("partial failure → 502 + partial", partialOutcome.httpStatus === 502 && partialOutcome.body.partial === true, partialOutcome.body);
  check(
    "chunksSent/chunksTotal reported",
    partialOutcome.body.chunksSent === 2 && partialOutcome.body.chunksTotal === 3,
    partialOutcome.body,
  );

  const thrown = createMockPlugin({
    sendText: async () => {
      throw new Error("socket hang up");
    },
  });
  const thrownOutcome = await executeSend({
    cfg: BASE_CFG,
    settings: ENABLED,
    request: { channel: "mock", to: "mock:c2c:abc123", text: "hi" },
    deps: depsFor(thrown.plugin),
  });
  check("thrown error → 502 (backstop)", thrownOutcome.httpStatus === 502, thrownOutcome.body);

  const hanging = createMockPlugin({ sendText: () => new Promise(() => {}) });
  const timeoutOutcome = await executeSend({
    cfg: BASE_CFG,
    settings: { ...ENABLED, timeoutMs: 60 },
    request: { channel: "mock", to: "mock:c2c:abc123", text: "hi" },
    deps: depsFor(hanging.plugin),
  });
  check("timeout → 502", timeoutOutcome.httpStatus === 502, timeoutOutcome.body);
  check("timeout carries reason + uncertain", timeoutOutcome.body.reason === "timeout" && timeoutOutcome.body.uncertain === true, timeoutOutcome.body);
}

// ── 7. Limits ─────────────────────────────────────────────────────────────

section("7. sendMaxTextLength");
{
  const { plugin } = createMockPlugin();
  const outcome = await executeSend({
    cfg: BASE_CFG,
    settings: { ...ENABLED, maxTextLength: 5 },
    request: { channel: "mock", to: "mock:c2c:abc123", text: "way too long" },
    deps: depsFor(plugin),
  });
  check("over limit → 400 INVALID_REQUEST", outcome.httpStatus === 400 && outcome.body.code === "INVALID_REQUEST", outcome.body);
}

// ── 8. HTTP route (real server, injected fixtures) ────────────────────────

section("8. HTTP /ocg/send route");
{
  const { plugin } = createMockPlugin();
  const secret = "route-secret";
  const settings = resolveSendSettings({ sendSecret: secret, sendMaxBodyBytes: 256 });
  const sendCtx = {
    getSettings: () => settings,
    getConfig: () => BASE_CFG,
    getPlugin: () => plugin as never,
    loadPlugin: async () => plugin as never,
  };

  const port = await startCallbackServer("127.0.0.1", 0, secret, { send: sendCtx });
  check("server bound to ephemeral port", port > 0 && getCallbackPort() === port, port);

  const url = `http://127.0.0.1:${port}/ocg/send`;
  const body = JSON.stringify({ channel: "mock", to: "mock:c2c:abc123", text: "hello" });
  const sign = (payload: string, key: string) =>
    `sha256=${createHmac("sha256", key).update(payload).digest("hex")}`;

  const okRes = await fetchNoKeepAlive(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OCG-Signature": sign(body, secret) },
    body,
  });
  const okBody = await okRes.json() as Record<string, unknown>;
  check("signed request → 200", okRes.status === 200 && okBody.ok === true, { status: okRes.status, okBody });

  const badSig = await fetchNoKeepAlive(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OCG-Signature": sign(body, "wrong-secret") },
    body,
  });
  const badSigBody = await badSig.json() as Record<string, unknown>;
  check("bad signature → 401 BAD_SIGNATURE", badSig.status === 401 && badSigBody.code === "BAD_SIGNATURE", badSigBody);

  const noSig = await fetchNoKeepAlive(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  check("missing signature → 401", noSig.status === 401, noSig.status);

  const tooLarge = await fetchNoKeepAlive(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OCG-Signature": sign("x", secret) },
    body: JSON.stringify({ channel: "mock", to: "mock:c2c:abc123", text: "z".repeat(400) }),
  });
  const tooLargeBody = await tooLarge.json() as Record<string, unknown>;
  check("oversized body → 413 PAYLOAD_TOO_LARGE", tooLarge.status === 413 && tooLargeBody.code === "PAYLOAD_TOO_LARGE", tooLargeBody);

  const preflight = await fetchNoKeepAlive(url, { method: "OPTIONS" });
  check("CORS preflight → 204", preflight.status === 204, preflight.status);

  const notFound = await fetchNoKeepAlive(`http://127.0.0.1:${port}/ocg/unknown`, { method: "POST", body: "{}" });
  check("other paths still 404", notFound.status === 404, notFound.status);

  await stopCallbackServer();

  const disabledSettings = resolveSendSettings({});
  await startCallbackServer("127.0.0.1", 0, undefined, {
    send: { ...sendCtx, getSettings: () => disabledSettings },
  });
  const disabledRes = await fetchNoKeepAlive(`http://127.0.0.1:${getCallbackPort()}/ocg/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const disabledBody = await disabledRes.json() as Record<string, unknown>;
  check("no secret → 403 DISABLED", disabledRes.status === 403 && disabledBody.code === "DISABLED", disabledBody);
  await stopCallbackServer();
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log("");
if (failures === 0) {
  console.log("✅ All send tests passed!\n");
  process.exitCode = 0;
} else {
  console.log(`❌ ${failures} send test check(s) failed!\n`);
  process.exitCode = 1;
}
