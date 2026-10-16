/**
 * Agent routes tests (OCG 1.3.0).
 *
 * HTTP-level pass over the real callback server with an injected agent
 * context: auth (local token / HMAC), long-poll wait woken by an enqueue,
 * reply via handle vs. degraded send, lease conflicts, mailbox-disabled.
 *
 * Run: npx tsx src/agent-routes-test.ts
 */

import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeRequest,
  type AgentRouteContext,
} from "./agent-routes.js";
import { startCallbackServer, stopCallbackServer } from "./callback-server.js";
import { buildOpenClawConfig, resolveMailboxSettings, resolveSendSettings, type LiteGatewayConfig } from "./config.js";
import { signRequest } from "./local-auth.js";
import { Mailbox, newMessageId, type InboundMessage } from "./mailbox.js";

// ── Harness ────────────────────────────────────────────────────────────────

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchNoKeepAlive(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { connection: "close", ...(init.headers ?? {}) },
  });
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: newMessageId(),
    channel: "mock",
    accountId: "default",
    target: "mock:c2c:abc123",
    sessionKey: "mock:agent:main:main",
    chatType: "direct",
    sender: { id: "abc123", name: "Peer" },
    groupSubject: null,
    text: "hello",
    media: [],
    platformMessageId: "p1",
    replyToId: null,
    wasMentioned: null,
    receivedAt: Date.now(),
    ...overrides,
  };
}

// Mock plugin (same shape as src/send-test.ts)
function createMockPlugin() {
  const calls: Array<Record<string, unknown>> = [];
  const plugin = {
    id: "mock",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (_cfg: unknown, accountId?: string | null) => ({
        accountId: accountId ?? "default",
        enabled: true,
        token: "mock-token",
      }),
      isConfigured: () => true,
    },
    messaging: {
      normalizeTarget: (raw: string) => (raw.startsWith("mock:") ? raw : `mock:${raw}`),
      targetResolver: {
        looksLikeId: (raw: string) => /^mock:(c2c|group):[a-z0-9]+$/i.test(raw),
      },
    },
    outbound: {
      textChunkLimit: 50,
      sanitizeText: ({ text }: { text: string }) => text.trim(),
      sendText: async (ctx: Record<string, unknown>) => {
        calls.push(ctx);
        return { channel: "mock", messageId: `m${calls.length}` };
      },
    },
  };
  return { plugin, calls };
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "ocg-agent-routes-test-"));
  const mailbox = new Mailbox({
    dir: join(tempDir, "mailbox"),
    settings: resolveMailboxSettings({ mailboxLeaseMs: 60_000 }),
    startTimers: false,
    log: () => {},
  });
  const { plugin, calls } = createMockPlugin();

  const raw: LiteGatewayConfig = {
    agentType: "mailbox",
    sendSecret: "route-secret",
    channels: { mock: { enabled: true, token: "mock-token" } },
  };
  const sendSettings = resolveSendSettings(raw);
  let mailboxEnabled = true;
  let sendAllowedOverride: string[] | null = null;

  const agentCtx: AgentRouteContext = {
    getRawConfig: () => raw,
    getConfig: () => buildOpenClawConfig(raw),
    getMailbox: () => mailbox,
    isMailboxEnabled: () => mailboxEnabled,
    getSendSettings: () => ({ ...sendSettings, allowedChannels: sendAllowedOverride ?? sendSettings.allowedChannels }),
    getLocalToken: () => "test-token",
    getChannelsStatus: () => [{ id: "mock", accountId: "default", status: "running" }],
    getPlugin: () => plugin as never,
    loadPlugin: async () => plugin as never,
    version: () => "0.0.0-test",
    startedAt: Date.now() - 1000,
  };

  const port = await startCallbackServer("127.0.0.1", 0, undefined, {
    agent: agentCtx,
    localToken: "test-token",
  });
  const base = `http://127.0.0.1:${port}`;
  const auth = { "X-OCG-Local-Token": "test-token", "Content-Type": "application/json" };
  console.log(`[agent-routes-test] server on ${base}`);

  // ── 1. auth ──────────────────────────────────────────────────────────────
  section("1. authentication");
  {
    const noAuth = await fetchNoKeepAlive(`${base}/ocg/health`);
    const noAuthBody = await noAuth.json() as Record<string, unknown>;
    check("no auth → 401 UNAUTHORIZED", noAuth.status === 401 && noAuthBody.code === "UNAUTHORIZED", noAuthBody);

    const badToken = await fetchNoKeepAlive(`${base}/ocg/health`, {
      headers: { "X-OCG-Local-Token": "wrong" },
    });
    check("wrong token → 401", badToken.status === 401, badToken.status);

    const okToken = await fetchNoKeepAlive(`${base}/ocg/health`, { headers: auth });
    const okBody = await okToken.json() as Record<string, unknown>;
    check("local token → 200", okToken.status === 200 && okBody.ok === true, okBody);
    check("health carries version", okBody.version === "0.0.0-test");
    check("health carries channels", Array.isArray(okBody.channels) && (okBody.channels as unknown[]).length === 1, okBody.channels);

    // Body-only HMAC over an empty GET body would be a permanent bearer token
    // for every read route — GETs must carry a timestamped signature.
    const bodyOnly = `sha256=${createHmac("sha256", "route-secret").update("").digest("hex")}`;
    const legacyGet = await fetchNoKeepAlive(`${base}/ocg/health`, {
      headers: { "X-OCG-Signature": bodyOnly },
    });
    const legacyGetBody = await legacyGet.json() as Record<string, unknown>;
    check("HMAC body-only on GET → 401", legacyGet.status === 401 && legacyGetBody.code === "UNAUTHORIZED", legacyGetBody);

    const ts = String(Math.floor(Date.now() / 1000));
    const signedGet = await fetchNoKeepAlive(`${base}/ocg/health`, {
      headers: { "X-OCG-Signature": signRequest("route-secret", ts, "GET", "/ocg/health"), "X-OCG-Timestamp": ts },
    });
    check("HMAC timestamped GET → 200", signedGet.status === 200, signedGet.status);

    const wrongPath = await fetchNoKeepAlive(`${base}/ocg/inbox?state=all`, {
      headers: { "X-OCG-Signature": signRequest("route-secret", ts, "GET", "/ocg/health"), "X-OCG-Timestamp": ts },
    });
    check("signature for another path → 401", wrongPath.status === 401, wrongPath.status);

    const staleTs = String(Math.floor(Date.now() / 1000) - 600);
    const stale = await fetchNoKeepAlive(`${base}/ocg/health`, {
      headers: { "X-OCG-Signature": signRequest("route-secret", staleTs, "GET", "/ocg/health"), "X-OCG-Timestamp": staleTs },
    });
    check("stale timestamp → 401", stale.status === 401, stale.status);

    // POST keeps accepting the legacy body-only signature (same as /ocg/send).
    const ackBody = JSON.stringify({ force: true });
    const legacyPost = await fetchNoKeepAlive(`${base}/ocg/inbox/m_nope/ack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OCG-Signature": `sha256=${createHmac("sha256", "route-secret").update(ackBody).digest("hex")}`,
      },
      body: ackBody,
    });
    check("HMAC body-only on POST still authenticates (404 past auth)", legacyPost.status === 404, legacyPost.status);

    // Loopback restriction — unit level, since a local socket IS loopback.
    const fakeReq = (remoteAddress: string): IncomingMessage => ({
      headers: { "x-ocg-local-token": "test-token" },
      socket: { remoteAddress },
    } as unknown as IncomingMessage);
    const restricted = authorizeRequest(fakeReq("10.1.2.3"), Buffer.alloc(0), {
      localToken: "test-token",
      localTokenLoopbackOnly: true,
      hmacSecret: null,
    });
    check("non-loopback token rejected when loopback-only", restricted.ok === false, restricted);
    const allowed = authorizeRequest(fakeReq("127.0.0.1"), Buffer.alloc(0), {
      localToken: "test-token",
      localTokenLoopbackOnly: true,
      hmacSecret: null,
    });
    check("loopback token accepted", allowed.ok === true, allowed);
  }

  // ── 2. long-poll wait woken by an enqueue ───────────────────────────────
  section("2. /ocg/inbox/wait long-poll");
  {
    const started = Date.now();
    const waitPromise = fetchNoKeepAlive(`${base}/ocg/inbox/wait?timeoutMs=5000&consumer=w1`, {
      headers: auth,
    });
    await sleep(250);
    const queued = mailbox.enqueue(makeMessage({ text: "wake" }));
    const response = await waitPromise;
    const body = await response.json() as Record<string, unknown>;
    const elapsed = Date.now() - started;
    check("wait returned 200", response.status === 200, response.status);
    check("woken well before timeout", elapsed < 3000, elapsed);
    const messages = body.messages as Array<Record<string, unknown>>;
    check("message delivered", messages.length === 1 && messages[0]?.id === queued.id, messages);
    check("leaseExpiresAt present", typeof body.leaseExpiresAt === "number", body.leaseExpiresAt);
    check("entry leased to w1", mailbox.get(queued.id)?.consumer === "w1", mailbox.get(queued.id));

    const timeoutRes = await fetchNoKeepAlive(`${base}/ocg/inbox/wait?timeoutMs=200&consumer=w1`, { headers: auth });
    const timeoutBody = await timeoutRes.json() as Record<string, unknown>;
    check("timeout → 200 + empty list", timeoutRes.status === 200 && (timeoutBody.messages as unknown[]).length === 0, timeoutBody);
  }

  // ── 3. reply via the reply handle ───────────────────────────────────────
  section("3. /ocg/inbox/{id}/reply via handle");
  {
    const delivered: string[] = [];
    const entry = mailbox.enqueue(makeMessage({ text: "question" }), {
      deliver: async (payload) => {
        delivered.push(String(payload.text));
      },
      expiresAt: Date.now() + 60_000,
    });

    const response = await fetchNoKeepAlive(`${base}/ocg/inbox/${entry.id}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "answer" }),
    });
    const body = await response.json() as Record<string, unknown>;
    check("reply → 200 via reply", response.status === 200 && body.via === "reply", body);
    check("handle deliver called", delivered.join("") === "answer", delivered);
    check("entry done by reply", mailbox.get(entry.id)?.doneBy === "reply", mailbox.get(entry.id));

    const again = await fetchNoKeepAlive(`${base}/ocg/inbox/${entry.id}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "answer again" }),
    });
    const againBody = await again.json() as Record<string, unknown>;
    check("second reply → 409 ALREADY_REPLIED", again.status === 409 && againBody.code === "ALREADY_REPLIED", againBody);
  }

  // ── 4. reply degrades to send (no handle) ───────────────────────────────
  section("4. /ocg/inbox/{id}/reply degraded send");
  {
    const entry = mailbox.enqueue(makeMessage({ text: "late question", target: "mock:c2c:abc123" }));
    calls.length = 0;
    const response = await fetchNoKeepAlive(`${base}/ocg/inbox/${entry.id}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "late answer" }),
    });
    const body = await response.json() as Record<string, unknown>;
    check("reply → 200 via send", response.status === 200 && body.via === "send", body);
    check("sendText called once", calls.length === 1, calls.length);
    check("sendText got the target", calls[0]?.to === "mock:c2c:abc123", calls[0]);
    check("sendText got the text", calls[0]?.text === "late answer", calls[0]);
    check("entry done after degrade", mailbox.get(entry.id)?.doneBy === "reply", mailbox.get(entry.id));

    // No target → cannot degrade.
    const orphan = mailbox.enqueue(makeMessage({ target: null }));
    const expired = await fetchNoKeepAlive(`${base}/ocg/inbox/${orphan.id}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "hello?" }),
    });
    const expiredBody = await expired.json() as Record<string, unknown>;
    check("no target → 410 REPLY_EXPIRED", expired.status === 410 && expiredBody.code === "REPLY_EXPIRED", expiredBody);

    // Channel not in sendAllowedChannels → the send contract says 404
    // UNKNOWN_CHANNEL; on the reply path that must read as REPLY_EXPIRED.
    sendAllowedOverride = ["other"];
    const blocked = mailbox.enqueue(makeMessage({ text: "blocked", target: "mock:c2c:abc123" }));
    const blockedRes = await fetchNoKeepAlive(`${base}/ocg/inbox/${blocked.id}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "late" }),
    });
    const blockedBody = await blockedRes.json() as Record<string, unknown>;
    sendAllowedOverride = null;
    check("disallowed channel → 410 REPLY_EXPIRED", blockedRes.status === 410 && blockedBody.code === "REPLY_EXPIRED", blockedBody);
    check("degraded failure carries the send outcome", (blockedBody.send as Record<string, unknown> | undefined)?.code === "UNKNOWN_CHANNEL", blockedBody.send);
    check("degraded failure leaves the entry open", mailbox.get(blocked.id)?.state !== "done", mailbox.get(blocked.id));
  }

  // ── 4b. wait: client disconnects after the lease → messages released ────
  section("4b. /ocg/inbox/wait abort releases the lease");
  {
    while (mailbox.stats().pending > 0) {
      await mailbox.wait({ consumer: "drain", max: 50, timeoutMs: 50 });
    }
    const controller = new AbortController();
    const pending = fetchNoKeepAlive(`${base}/ocg/inbox/wait?timeoutMs=5000&consumer=gone`, {
      headers: auth,
      signal: controller.signal,
    }).catch(() => null);
    await sleep(250);
    controller.abort();
    await pending;
    await sleep(150);
    const late = mailbox.enqueue(makeMessage({ text: "after abort" }));
    await sleep(100);
    check("message enqueued after abort stays pending", mailbox.get(late.id)?.state === "pending", mailbox.get(late.id));

    // Lease granted, then the client vanishes before the body is written:
    // exercise the Mailbox API the handler uses for that case (release).
    const leased = await mailbox.wait({ consumer: "gone", timeoutMs: 50 });
    check("leased to gone", leased.messages[0]?.id === late.id && mailbox.get(late.id)?.state === "leased");
    const released = mailbox.release([late.id], "gone");
    const after = mailbox.get(late.id);
    check("release → pending, no redelivery counted", released === 1 && after?.state === "pending" && after?.redeliveries === 0, after);
    check("release by non-holder is a no-op", mailbox.release([late.id], "someone") === 0);
    mailbox.ack(late.id, { force: true });
  }

  // ── 5. ack: lease conflict + force ──────────────────────────────────────
  section("5. /ocg/inbox/{id}/ack");
  {
    // Drain leftovers from earlier sections so the next wait leases OUR entry.
    while (mailbox.stats().pending > 0) {
      await mailbox.wait({ consumer: "drain", max: 50, timeoutMs: 50 });
    }

    const entry = mailbox.enqueue(makeMessage());
    const held = await fetchNoKeepAlive(`${base}/ocg/inbox/wait?timeoutMs=100&consumer=w2`, { headers: auth });
    const heldBody = await held.json() as Record<string, unknown>;
    check("w2 holds the lease", (heldBody.messages as Array<Record<string, unknown>>)[0]?.id === entry.id, heldBody.messages);

    const conflict = await fetchNoKeepAlive(`${base}/ocg/inbox/${entry.id}/ack`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ consumer: "w1" }),
    });
    const conflictBody = await conflict.json() as Record<string, unknown>;
    check("other consumer → 409 LEASE_HELD_BY_OTHER", conflict.status === 409 && conflictBody.code === "LEASE_HELD_BY_OTHER", conflictBody);

    const forced = await fetchNoKeepAlive(`${base}/ocg/inbox/${entry.id}/ack`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ consumer: "w1", force: true }),
    });
    const forcedBody = await forced.json() as Record<string, unknown>;
    check("force → 200 done", forced.status === 200 && forcedBody.ok === true && forcedBody.state === "done", forcedBody);
  }

  // ── 6. list / show / targets ────────────────────────────────────────────
  section("6. inbox list / show / targets");
  {
    const waiting = mailbox.enqueue(makeMessage({ text: "listing" }));
    const list = await fetchNoKeepAlive(`${base}/ocg/inbox?state=pending&limit=10`, { headers: auth });
    const listBody = await list.json() as Record<string, unknown>;
    const entries = listBody.entries as Array<Record<string, unknown>>;
    check("list returns pending entries", entries.some((entry) => entry.id === waiting.id), entries.map((entry) => entry.id));

    const invalidState = await fetchNoKeepAlive(`${base}/ocg/inbox?state=bogus`, { headers: auth });
    check("bad state → 400", invalidState.status === 400, invalidState.status);

    const show = await fetchJson(`${base}/ocg/inbox/${waiting.id}`, auth);
    check("show returns the entry", show.status === 200 && ((show.body.entry as Record<string, unknown>)?.id === waiting.id), show.body);
    const missing = await fetchJson(`${base}/ocg/inbox/m_doesnotexist`, auth);
    check("unknown id → 404", missing.status === 404, missing.status);

    const targets = await fetchJson(`${base}/ocg/targets`, auth);
    const targetList = targets.body.targets as Array<Record<string, unknown>>;
    check("targets contain the peer", targetList.some((target) => target.target === "mock:c2c:abc123"), targetList);

    const wrongMethod = await fetchNoKeepAlive(`${base}/ocg/health`, { method: "POST", headers: auth, body: "{}" });
    check("POST /ocg/health → 405", wrongMethod.status === 405, wrongMethod.status);
  }

  // ── 7. mailbox disabled ────────────────────────────────────────────────
  section("7. MAILBOX_DISABLED");
  {
    mailboxEnabled = false;
    const disabled = await fetchNoKeepAlive(`${base}/ocg/inbox`, { headers: auth });
    const disabledBody = await disabled.json() as Record<string, unknown>;
    check("inbox → 403 MAILBOX_DISABLED", disabled.status === 403 && disabledBody.code === "MAILBOX_DISABLED", disabledBody);

    const health = await fetchNoKeepAlive(`${base}/ocg/health`, { headers: auth });
    const healthBody = await health.json() as Record<string, unknown>;
    check("health still answers", health.status === 200 && (healthBody.mailbox as Record<string, unknown>).enabled === false, healthBody);
    mailboxEnabled = true;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  await stopCallbackServer();
  mailbox.dispose();
  rmSync(tempDir, { recursive: true, force: true });

  console.log("");
  if (failures === 0) {
    console.log("✅ All agent-routes tests passed!\n");
    process.exitCode = 0;
  } else {
    console.log(`❌ ${failures} agent-routes test check(s) failed!\n`);
    process.exitCode = 1;
  }
}

/** fetch + JSON body helper (GET convenience). */
async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchNoKeepAlive(url, { headers });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

await main();
