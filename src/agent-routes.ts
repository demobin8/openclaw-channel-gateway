/**
 * Agent-facing daemon routes (OCG 1.3.0):
 *
 *   GET  /ocg/health
 *   GET  /ocg/inbox/wait
 *   GET  /ocg/inbox
 *   GET  /ocg/inbox/{id}
 *   POST /ocg/inbox/{id}/ack
 *   POST /ocg/inbox/{id}/reply
 *   GET  /ocg/targets
 *
 * Every route accepts either the local token (`X-OCG-Local-Token`, loopback
 * only when the server binds a wildcard host) or an HMAC signature
 * (`X-OCG-Signature`).  Signatures bind method, path and a timestamp
 * (`X-OCG-Timestamp`, see `verifySignedRequest`); POST routes additionally
 * accept the legacy body-only form.  Error responses use the common
 * `{ ok:false, code, message, hint? }` shape.
 *
 * See docs/techdesign-agent-cli.md §5.5 / §5.6.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import {
  buildOpenClawConfig,
  isMailboxConfigured,
  loadConfig,
  resolveChannelAgentType,
  resolveSendSettings,
  type LiteGatewayConfig,
  type SendSettings,
} from "./config.js";
import { ensureMailbox, type Mailbox, type MailboxState } from "./mailbox.js";
import { isLoopbackAddress, localTokenMatches, readLocalToken, verifySignedRequest } from "./local-auth.js";
import { jsonBody, readBodyLimited } from "./http-util.js";
import { deliverPayloadInChunks, resolveReplyChunkSize, rewriteLocalMediaPathsForDelivery } from "./reply-chunking.js";
import { executeSend } from "./send-service.js";
import {
  ensureChannelPluginLoaded,
  getChannelPlugin,
  listRunningAccounts,
  type ChannelPluginObject,
} from "./plugin-loader.js";

// ── Route context (injection seam; tests supply fixtures) ─────────────────

export type AgentRouteContext = {
  getRawConfig: () => LiteGatewayConfig | null;
  getConfig: () => Record<string, unknown>;
  getMailbox: () => Mailbox;
  isMailboxEnabled: () => boolean;
  getSendSettings: () => SendSettings;
  getLocalToken: () => string | null;
  getChannelsStatus?: () => Array<Record<string, unknown>>;
  getPlugin?: (channelId: string) => ChannelPluginObject | null;
  loadPlugin?: (channelId: string) => Promise<ChannelPluginObject | null>;
  version?: () => string;
  startedAt?: number;
  now?: () => number;
  log?: (line: string) => void;
};

const MODULE_STARTED_AT = Date.now();

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildChannelsStatus(raw: LiteGatewayConfig | null): Array<Record<string, unknown>> {
  const running = listRunningAccounts();
  const configured = raw?.channels ? Object.keys(raw.channels) : [];
  const out: Array<Record<string, unknown>> = [];
  for (const { channelId, accountId } of running) {
    out.push({ id: channelId, accountId, status: "running" });
  }
  for (const id of configured) {
    if (!running.some((entry) => entry.channelId === id)) {
      out.push({ id, accountId: null, status: "stopped" });
    }
  }
  return out;
}

export function defaultAgentRouteContext(): AgentRouteContext {
  return {
    getRawConfig: () => loadConfig(),
    getConfig: () => buildOpenClawConfig(loadConfig() ?? {}),
    getMailbox: () => ensureMailbox(),
    isMailboxEnabled: () => isMailboxConfigured(loadConfig() ?? {}),
    getSendSettings: () => resolveSendSettings(loadConfig()),
    getLocalToken: () => readLocalToken(),
    getChannelsStatus: () => buildChannelsStatus(loadConfig()),
    getPlugin: getChannelPlugin,
    loadPlugin: ensureChannelPluginLoaded,
    version: readPackageVersion,
    startedAt: MODULE_STARTED_AT,
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────

export type RouteAuthOptions = {
  localToken: string | null;
  /** True when the server binds a wildcard host (0.0.0.0 / ::). */
  localTokenLoopbackOnly: boolean;
  /** Secret for `X-OCG-Signature` verification (sendSecret ?? callbackSecret). */
  hmacSecret: string | null;
  /** Clock source for the timestamp window (tests). */
  now?: () => number;
};

export type RouteAuthResult =
  | { ok: true; via: "local" | "hmac" }
  | { ok: false; status: number; body: Record<string, unknown> };

export function authorizeRequest(
  req: IncomingMessage,
  rawBody: Buffer,
  options: RouteAuthOptions,
  url?: URL,
): RouteAuthResult {
  const tokenHeader = req.headers["x-ocg-local-token"];
  const provided = typeof tokenHeader === "string" ? tokenHeader : undefined;

  if (localTokenMatches(options.localToken, provided)) {
    if (options.localTokenLoopbackOnly && !isLoopbackAddress(req.socket?.remoteAddress)) {
      return {
        ok: false,
        status: 401,
        body: {
          ok: false,
          code: "UNAUTHORIZED",
          message: "local token is accepted from loopback connections only",
          hint: "bind callbackHost to 127.0.0.1 or use the HMAC signature for remote callers",
        },
      };
    }
    return { ok: true, via: "local" };
  }

  if (options.hmacSecret) {
    const signature = req.headers["x-ocg-signature"];
    const timestamp = req.headers["x-ocg-timestamp"];
    const requestUrl = url ?? new URL(req.url ?? "/", "http://localhost");
    const verdict = verifySignedRequest({
      secret: options.hmacSecret,
      method: req.method ?? "GET",
      pathWithQuery: `${requestUrl.pathname}${requestUrl.search}`,
      rawBody,
      signatureHeader: typeof signature === "string" ? signature : undefined,
      timestampHeader: typeof timestamp === "string" ? timestamp : undefined,
      now: options.now?.(),
    });
    if (verdict.ok) return { ok: true, via: "hmac" };
    if (verdict.reason === "timestamp-required" || verdict.reason === "stale-timestamp") {
      return {
        ok: false,
        status: 401,
        body: {
          ok: false,
          code: "UNAUTHORIZED",
          message: verdict.reason === "stale-timestamp"
            ? "X-OCG-Timestamp is missing, malformed or outside the 5-minute window"
            : "GET routes require a timestamped signature",
          hint:
            "send X-OCG-Timestamp (unix seconds) and sign " +
            "\"<timestamp>\\n<METHOD>\\n<path?query>\\n\" + body with HMAC-SHA256",
        },
      };
    }
  }

  return {
    ok: false,
    status: 401,
    body: {
      ok: false,
      code: "UNAUTHORIZED",
      message: "missing or invalid authentication",
      hint: "pass X-OCG-Local-Token (see <configDir>/ocg-local-token) or a valid X-OCG-Signature",
    },
  };
}

/** Build the auth options for a server that knows its bind host. */
export function agentRouteAuthOptions(ctx: AgentRouteContext, wildcardHost: boolean): RouteAuthOptions {
  let secret: string | null = null;
  try {
    secret = ctx.getSendSettings().secret;
  } catch {
    secret = null;
  }
  return {
    localToken: ctx.getLocalToken(),
    localTokenLoopbackOnly: wildcardHost,
    hmacSecret: secret,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

const MAILBOX_BODY_LIMIT = 1024 * 1024;

function respondError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  jsonBody(res, status, { ok: false, code, message, ...extra });
}

type ParsedBody =
  | { ok: true; value: Record<string, unknown>; raw: Buffer }
  | { ok: false; status: number; code: string; message: string };

async function readJsonBody(req: IncomingMessage): Promise<ParsedBody> {
  let raw: Buffer;
  try {
    raw = await readBodyLimited(req, MAILBOX_BODY_LIMIT);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PAYLOAD_TOO_LARGE") {
      return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", message: (err as Error).message };
    }
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: (err as Error).message };
  }
  if (raw.length === 0) return { ok: true, value: {}, raw };
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return { ok: true, value: parsed as Record<string, unknown>, raw };
  } catch (err) {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: (err as Error).message };
  }
}

function resolveConsumer(explicit: unknown, url: URL): string {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  const fromQuery = url.searchParams.get("consumer");
  if (fromQuery && fromQuery.trim() !== "") return fromQuery.trim();
  const fromEnv = process.env.OCG_CONSUMER;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  return "default";
}

function parseForce(value: unknown, url: URL): boolean {
  if (value === true) return true;
  const fromQuery = url.searchParams.get("force");
  return fromQuery === "1" || fromQuery === "true";
}

type NumberParam =
  | { ok: true; value: number | undefined }
  | { ok: false; message: string };

function numberParam(url: URL, name: string): NumberParam {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return { ok: true, value: undefined };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: `"${name}" must be a number` };
  }
  return { ok: true, value: parsed };
}

// ── Handlers ──────────────────────────────────────────────────────────────

function handleHealth(res: ServerResponse, ctx: AgentRouteContext): void {
  let stats = { pending: 0, leased: 0, done: 0, oldestPendingAt: null as number | null };
  try {
    stats = ctx.getMailbox().stats();
  } catch {
    // Mailbox unavailable — health still answers so doctor can distinguish.
  }
  const globalType = (() => {
    try {
      return resolveChannelAgentType(undefined, ctx.getConfig());
    } catch {
      return ctx.getRawConfig()?.agentType ?? "http";
    }
  })();

  jsonBody(res, 200, {
    ok: true,
    version: ctx.version?.() ?? readPackageVersion(),
    pid: process.pid,
    uptimeMs: Math.max(0, (ctx.now?.() ?? Date.now()) - (ctx.startedAt ?? MODULE_STARTED_AT)),
    agentType: globalType,
    mailbox: {
      enabled: ctx.isMailboxEnabled(),
      pending: stats.pending,
      leased: stats.leased,
      done: stats.done,
      oldestPendingAt: stats.oldestPendingAt,
    },
    channels: ctx.getChannelsStatus?.() ?? [],
  });
}

async function handleInboxWait(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  mailbox: Mailbox,
): Promise<void> {
  const consumer = resolveConsumer(undefined, url);
  const timeoutParam = numberParam(url, "timeoutMs");
  if (!timeoutParam.ok) {
    return respondError(res, 400, "INVALID_REQUEST", timeoutParam.message);
  }
  const maxParam = numberParam(url, "max");
  if (!maxParam.ok) {
    return respondError(res, 400, "INVALID_REQUEST", maxParam.message);
  }
  const channel = url.searchParams.get("channel");
  const peek = url.searchParams.get("peek") === "1" || url.searchParams.get("peek") === "true";

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  // Respond 200 with headers now; keep the connection warm with a whitespace
  // ping every 15 s (proxies/firewalls drop idle sockets — risk R3).
  res.writeHead(200, { "Content-Type": "application/json" });
  const keepAlive = setInterval(() => {
    try {
      res.write(" ");
    } catch {
      // Connection already gone.
    }
  }, 15_000);

  try {
    const result = await mailbox.wait({
      consumer,
      channel: channel ?? undefined,
      timeoutMs: timeoutParam.value,
      max: maxParam.value,
      peek,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      // The client went away between the lease being granted and the response
      // being written. Nobody received these messages, so hand them straight
      // back to the queue instead of letting them sit leased for a full
      // mailboxLeaseMs (review finding 4).
      if (!peek && result.messages.length > 0) {
        mailbox.release(result.messages.map((message) => message.id), consumer);
      }
      try {
        res.end();
      } catch {
        // Already closed.
      }
      return;
    }
    res.end(JSON.stringify({
      ok: true,
      consumer,
      messages: result.messages,
      leaseExpiresAt: result.leaseExpiresAt,
    }));
  } finally {
    clearInterval(keepAlive);
  }
}

function handleInboxList(res: ServerResponse, url: URL, mailbox: Mailbox): void {
  const stateParam = url.searchParams.get("state");
  let states: MailboxState[] | undefined;
  if (stateParam && stateParam !== "all") {
    const parts = stateParam.split(",").map((part) => part.trim()).filter((part) => part !== "");
    const valid: MailboxState[] = ["pending", "leased", "done"];
    const invalid = parts.find((part) => !valid.includes(part as MailboxState));
    if (invalid) {
      return respondError(
        res,
        400,
        "INVALID_REQUEST",
        `unknown state "${invalid}" (use pending, leased, done or all)`,
      );
    }
    states = parts as MailboxState[];
  } else if (!stateParam) {
    states = ["pending", "leased"];
  }

  const limitParam = numberParam(url, "limit");
  if (!limitParam.ok) return respondError(res, 400, "INVALID_REQUEST", limitParam.message);
  const sinceParam = numberParam(url, "since");
  if (!sinceParam.ok) return respondError(res, 400, "INVALID_REQUEST", sinceParam.message);

  const entries = mailbox.list({
    ...(states ? { states } : {}),
    channel: url.searchParams.get("channel"),
    limit: limitParam.value,
    since: sinceParam.value ?? null,
  });
  jsonBody(res, 200, { ok: true, entries });
}

function handleInboxShow(res: ServerResponse, id: string, mailbox: Mailbox): void {
  const entry = mailbox.get(id);
  if (!entry) return respondError(res, 404, "NOT_FOUND", `unknown message id "${id}"`);
  jsonBody(res, 200, { ok: true, entry });
}

function handleAck(
  res: ServerResponse,
  url: URL,
  id: string,
  body: Record<string, unknown>,
  mailbox: Mailbox,
): void {
  const consumer = resolveConsumer(body.consumer, url);
  const force = parseForce(body.force, url);
  const result = mailbox.ack(id, { consumer, force });
  if (!result.ok) {
    if (result.code === "NOT_FOUND") {
      return respondError(res, 404, "NOT_FOUND", result.message);
    }
    return respondError(res, 409, "LEASE_HELD_BY_OTHER", result.message, {
      hint: "retry as the lease holder, or pass force=1 for human intervention",
    });
  }
  jsonBody(res, 200, {
    ok: true,
    id,
    state: "done",
    ...(result.alreadyDone ? { alreadyDone: true } : { doneBy: "ack" }),
  });
}

async function handleReply(
  res: ServerResponse,
  url: URL,
  id: string,
  body: Record<string, unknown>,
  ctx: AgentRouteContext,
  mailbox: Mailbox,
): Promise<void> {
  const entry = mailbox.get(id);
  if (!entry) return respondError(res, 404, "NOT_FOUND", `unknown message id "${id}"`);

  if (entry.state === "done" && entry.doneBy === "reply") {
    return respondError(res, 409, "ALREADY_REPLIED", `message "${id}" was already replied to`, {
      doneAt: entry.doneAt,
    });
  }

  const text = typeof body.text === "string" ? body.text : "";
  const mediaUrl = typeof body.mediaUrl === "string" && body.mediaUrl.trim() !== ""
    ? body.mediaUrl.trim()
    : undefined;
  const isError = body.isError === true;
  if (text.trim() === "" && !mediaUrl) {
    return respondError(res, 400, "INVALID_REQUEST", "text or mediaUrl is required");
  }

  const consumer = resolveConsumer(body.consumer, url);
  const force = parseForce(body.force, url);
  if (
    !force &&
    entry.state === "leased" &&
    entry.consumer &&
    entry.consumer !== consumer
  ) {
    return respondError(
      res,
      409,
      "LEASE_HELD_BY_OTHER",
      `message "${id}" is leased by consumer "${entry.consumer}"`,
      { hint: "retry as the lease holder, or pass force=1 for human intervention" },
    );
  }

  const now = ctx.now ?? Date.now;
  const startedAt = now();
  const notes: string[] = [];
  let replyText = text;
  let mediaForSend = mediaUrl;
  let replyable = mailbox.hasReplyHandle(id);

  if (replyable && mediaUrl) {
    if (entry.channel === "qqbot") {
      // The passive-reply path only carries text; QQ media rides along as an
      // inline <qqmedia> tag (rewritten into the plugin's allowlisted dir).
      replyText = replyText.trim() === ""
        ? `<qqmedia>${mediaUrl}</qqmedia>`
        : `${replyText}\n<qqmedia>${mediaUrl}</qqmedia>`;
      mediaForSend = undefined;
      notes.push("mediaUrl folded into the reply text as a <qqmedia> tag");
    } else {
      // Other channels have no inline-media reply primitive — degrade to send.
      replyable = false;
      notes.push("reply handle does not support media; used the proactive send path");
    }
  }

  if (replyable) {
    const handle = mailbox.consumeReplyHandle(id);
    if (handle) {
      const outgoing = entry.channel === "qqbot"
        ? rewriteLocalMediaPathsForDelivery(replyText)
        : replyText;
      const chunkSize = resolveReplyChunkSize(
        (ctx.getRawConfig() as LiteGatewayConfig | null)?.replyChunkSize,
      );
      try {
        const chunks = await deliverPayloadInChunks(
          handle.deliver,
          { text: outgoing, isError },
          { kind: "final", assistantMessageIndex: 0 },
          chunkSize,
        );
        const updated = mailbox.markReplied(id);
        console.log(`[ocg:mailbox] replied id=${id} via=reply chunks=${chunks}`);
        jsonBody(res, 200, {
          ok: true,
          id,
          via: "reply",
          replyable: updated?.replyable ?? false,
          chunks,
          elapsedMs: now() - startedAt,
          ...(notes.length > 0 ? { notes } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ocg:mailbox] reply delivery failed id=${id}: ${message}`);
        respondError(res, 500, "INTERNAL_ERROR", `reply delivery failed: ${message}`, {
          id,
          via: "reply",
        });
      }
      return;
    }
    // Handle vanished between the check and the consume — fall through to send.
    notes.push("reply handle expired while replying; used the proactive send path");
  }

  // ── Degraded path: proactive send to the message's own peer ─────────────
  if (!entry.target) {
    return respondError(
      res,
      410,
      "REPLY_EXPIRED",
      "reply window expired and the peer target is unknown; this message cannot be delivered",
      { id, hint: "the message has no addressable target (ctx.From was unknown at enqueue time)" },
    );
  }

  const raw = ctx.getRawConfig();
  const base = ctx.getSendSettings();
  // The caller authenticated via local token/HMAC; the sendSecret gate does not
  // apply, but an explicit sendEnabled:false still does (§5.5 step 3).
  const settings: SendSettings = {
    ...base,
    enabled: raw?.sendEnabled !== false,
  };

  try {
    const outcome = await executeSend({
      cfg: ctx.getConfig(),
      settings,
      request: {
        channel: entry.channel,
        accountId: entry.accountId,
        to: entry.target,
        text: replyText,
        mediaUrl: mediaForSend,
      },
      deps: {
        ...(ctx.getPlugin ? { getPlugin: ctx.getPlugin } : {}),
        ...(ctx.loadPlugin ? { loadPlugin: ctx.loadPlugin } : {}),
      },
    });

    if (outcome.body.ok !== true) {
      // Addressing failures on the degraded path mean "this peer can no longer
      // be reached by a proactive send" — surface them as REPLY_EXPIRED so the
      // CLI maps them to a delivery failure (exit 1), not to "bad arguments"
      // (UNKNOWN_CHANNEL is a 404 in the send contract; review finding 5).
      const sendCode = typeof outcome.body.code === "string" ? outcome.body.code : "";
      if (sendCode === "UNKNOWN_CHANNEL" || sendCode === "UNKNOWN_ACCOUNT" || sendCode === "INVALID_TARGET") {
        const reason = sendCode === "UNKNOWN_CHANNEL"
          ? `channel "${entry.channel}" is not allowed for proactive send (sendAllowedChannels)`
          : String(outcome.body.message ?? sendCode);
        respondError(res, 410, "REPLY_EXPIRED", `reply window expired and the peer cannot be reached by send: ${reason}`, {
          id,
          via: "send",
          send: outcome.body,
          hint: sendCode === "UNKNOWN_CHANNEL"
            ? `add "${entry.channel}" to sendAllowedChannels, or reply within replyExpiresAt`
            : "reply within replyExpiresAt next time; the recorded target is not addressable",
          ...(notes.length > 0 ? { notes } : {}),
        });
        return;
      }
      jsonBody(res, outcome.httpStatus, {
        ...outcome.body,
        id,
        via: "send",
        send: outcome.body,
        ...(notes.length > 0 ? { notes } : {}),
      });
      return;
    }

    mailbox.markReplied(id);
    console.log(`[ocg:mailbox] replied id=${id} via=send`);
    jsonBody(res, 200, {
      ok: true,
      id,
      via: "send",
      chunks: outcome.body.chunks,
      elapsedMs: now() - startedAt,
      send: outcome.body,
      ...(notes.length > 0 ? { notes } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ocg:mailbox] degraded send failed id=${id}: ${message}`);
    respondError(res, 500, "INTERNAL_ERROR", message, { id, via: "send" });
  }
}

function handleTargets(res: ServerResponse, url: URL, mailbox: Mailbox): void {
  const limitParam = numberParam(url, "limit");
  if (!limitParam.ok) return respondError(res, 400, "INVALID_REQUEST", limitParam.message);
  const targets = mailbox.targets({
    channel: url.searchParams.get("channel"),
    limit: limitParam.value,
  });
  jsonBody(res, 200, { ok: true, targets });
}

// ── Route table ───────────────────────────────────────────────────────────

const inboxItemPattern = /^\/ocg\/inbox\/([A-Za-z0-9_-]+)$/;
const inboxAckPattern = /^\/ocg\/inbox\/([A-Za-z0-9_-]+)\/ack$/;
const inboxReplyPattern = /^\/ocg\/inbox\/([A-Za-z0-9_-]+)\/reply$/;

export function isAgentRoutePath(pathname: string): boolean {
  return (
    pathname === "/ocg/health" ||
    pathname === "/ocg/inbox" ||
    pathname === "/ocg/inbox/wait" ||
    pathname === "/ocg/targets" ||
    inboxItemPattern.test(pathname) ||
    inboxAckPattern.test(pathname) ||
    inboxReplyPattern.test(pathname)
  );
}

/**
 * Dispatch one request against the agent route table. Returns true when the
 * request matched a route (handled, rejected or unauthorized).
 */
export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AgentRouteContext,
  auth: RouteAuthOptions,
): Promise<boolean> {
  const pathname = url.pathname;
  const method = req.method ?? "GET";
  if (!isAgentRoutePath(pathname)) return false;

  const expectsGet =
    method === "GET" &&
    (pathname === "/ocg/health" ||
      pathname === "/ocg/inbox" ||
      pathname === "/ocg/inbox/wait" ||
      pathname === "/ocg/targets" ||
      inboxItemPattern.test(pathname));
  const expectsPost =
    method === "POST" &&
    (inboxAckPattern.test(pathname) || inboxReplyPattern.test(pathname));
  if (!expectsGet && !expectsPost) {
    respondError(res, 405, "METHOD_NOT_ALLOWED", `${method} is not supported for ${pathname}`);
    return true;
  }

  // Read the body before auth so the HMAC path can verify the exact bytes.
  let body: Record<string, unknown> = {};
  let rawBody: Buffer = Buffer.alloc(0);
  if (method === "POST") {
    const read = await readJsonBody(req);
    if (!read.ok) {
      respondError(res, read.status, read.code, read.message);
      return true;
    }
    body = read.value;
    rawBody = read.raw;
  }

  const authorized = authorizeRequest(req, rawBody, auth, url);
  if (!authorized.ok) {
    jsonBody(res, authorized.status, authorized.body);
    return true;
  }

  // `/ocg/health` doubles as a daemon liveness probe and answers even when
  // mailbox mode is off; everything else requires it.
  if (pathname !== "/ocg/health" && !ctx.isMailboxEnabled()) {
    respondError(
      res,
      403,
      "MAILBOX_DISABLED",
      "mailbox mode is not enabled; set agentType to \"mailbox\" to use inbox/reply",
      { hint: "see docs/techdesign-agent-cli.md §5.13" },
    );
    return true;
  }

  let mailbox: Mailbox;
  try {
    mailbox = ctx.getMailbox();
  } catch (err) {
    respondError(res, 500, "INTERNAL_ERROR", `mailbox unavailable: ${(err as Error).message}`);
    return true;
  }

  const itemMatch = inboxItemPattern.exec(pathname);
  const ackMatch = inboxAckPattern.exec(pathname);
  const replyMatch = inboxReplyPattern.exec(pathname);

  if (pathname === "/ocg/health") {
    handleHealth(res, ctx);
    return true;
  }
  if (pathname === "/ocg/inbox/wait") {
    await handleInboxWait(req, res, url, mailbox);
    return true;
  }
  if (pathname === "/ocg/inbox") {
    handleInboxList(res, url, mailbox);
    return true;
  }
  if (itemMatch) {
    handleInboxShow(res, itemMatch[1], mailbox);
    return true;
  }
  if (ackMatch) {
    handleAck(res, url, ackMatch[1], body, mailbox);
    return true;
  }
  if (replyMatch) {
    await handleReply(res, url, replyMatch[1], body, ctx, mailbox);
    return true;
  }
  if (pathname === "/ocg/targets") {
    handleTargets(res, url, mailbox);
    return true;
  }

  return false;
}
