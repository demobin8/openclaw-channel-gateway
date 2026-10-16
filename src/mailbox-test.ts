/**
 * Mailbox transport tests (OCG 1.3.0).
 *
 * Unit-level coverage of `src/mailbox.ts` (queue, leases, redelivery, JSONL
 * replay, media download, targets) plus a `dispatchInbound` integration pass:
 * a message enqueued from a plugin ctx is pulled, replied to through the reply
 * handle and marked done.
 *
 * Run: npx tsx src/mailbox-test.ts
 */

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Mailbox,
  getMailbox,
  newMessageId,
  resetMailbox,
  type InboundMessage,
  type MailboxSettings,
} from "./mailbox.js";
import { dispatchInbound } from "./inbound.js";
import { buildOpenClawConfig, resolveMailboxSettings, type LiteGatewayConfig } from "./config.js";
import { deliverPayloadInChunks } from "./reply-chunking.js";

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

const tempRoot = mkdtempSync(join(tmpdir(), "ocg-mailbox-test-"));
let dirCounter = 0;

function freshDir(): string {
  dirCounter += 1;
  return join(tempRoot, `case-${dirCounter}`);
}

function makeSettings(overrides: Partial<MailboxSettings> = {}): MailboxSettings {
  return { ...resolveMailboxSettings({}), ...overrides };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: newMessageId(),
    channel: "mock",
    accountId: "default",
    target: "mock:c2c:peer1",
    sessionKey: "mock:agent:main:main",
    chatType: "direct",
    sender: { id: "peer1", name: "Peer One" },
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

async function main(): Promise<void> {
  // ── 1. enqueue → wait leases ─────────────────────────────────────────────
  section("1. enqueue → wait (lease, consumer)");
  {
    const mailbox = new Mailbox({ dir: freshDir(), settings: makeSettings(), startTimers: false, log: () => {} });
    const entry = mailbox.enqueue(makeMessage({ text: "first" }));
    check("enqueue returns pending entry", entry.state === "pending" && entry.redeliveries === 0, entry);

    const result = await mailbox.wait({ consumer: "c1", timeoutMs: 100 });
    check("wait returns 1 message", result.messages.length === 1, result.messages.length);
    check("message text intact", result.messages[0]?.text === "first");
    check("leaseExpiresAt set", typeof result.leaseExpiresAt === "number");

    const after = mailbox.get(entry.id);
    check("entry is leased to c1", after?.state === "leased" && after?.consumer === "c1", after);
    mailbox.dispose();
  }

  // ── 2. wait timeout → empty, exit 0 semantics ────────────────────────────
  section("2. wait timeout → empty list");
  {
    const mailbox = new Mailbox({ dir: freshDir(), settings: makeSettings(), startTimers: false, log: () => {} });
    const started = Date.now();
    const result = await mailbox.wait({ consumer: "c1", timeoutMs: 120 });
    const elapsed = Date.now() - started;
    check("empty messages", result.messages.length === 0);
    check("waited ~timeout", elapsed >= 100 && elapsed < 2000, elapsed);
    check("leaseExpiresAt null", result.leaseExpiresAt === null);
    mailbox.dispose();
  }

  // ── 3. enqueue wakes a long-poll waiter ──────────────────────────────────
  section("3. long-poll wake-up");
  {
    const mailbox = new Mailbox({ dir: freshDir(), settings: makeSettings(), startTimers: false, log: () => {} });
    const started = Date.now();
    const pending = mailbox.wait({ consumer: "c1", timeoutMs: 5000 });
    setTimeout(() => {
      mailbox.enqueue(makeMessage({ text: "wake up" }));
    }, 100);
    const result = await pending;
    const elapsed = Date.now() - started;
    check("woken with a message", result.messages.length === 1 && result.messages[0]?.text === "wake up");
    check("woke early (<2s)", elapsed < 2000, elapsed);
    mailbox.dispose();
  }

  // ── 4. channel filter, max, peek ─────────────────────────────────────────
  section("4. channel filter + max + peek");
  {
    const mailbox = new Mailbox({ dir: freshDir(), settings: makeSettings(), startTimers: false, log: () => {} });
    mailbox.enqueue(makeMessage({ channel: "alpha", text: "a1" }));
    mailbox.enqueue(makeMessage({ channel: "beta", text: "b1" }));
    mailbox.enqueue(makeMessage({ channel: "alpha", text: "a2" }));

    const beta = await mailbox.wait({ consumer: "c1", channel: "beta", max: 2, timeoutMs: 100 });
    check("channel filter picks only beta", beta.messages.length === 1 && beta.messages[0]?.text === "b1");

    const alpha = await mailbox.wait({ consumer: "c1", channel: "alpha", max: 2, timeoutMs: 100 });
    check("max=2 takes both alpha messages", alpha.messages.length === 2, alpha.messages.map((m) => m.text));

    const peeked = await mailbox.wait({ consumer: "c2", timeoutMs: 500, peek: true, max: 5 });
    check("peek returns 0 (everything leased)", peeked.messages.length === 0, peeked.messages.length);

    mailbox.enqueue(makeMessage({ channel: "alpha", text: "a3" }));
    const peek = await mailbox.wait({ consumer: "c2", timeoutMs: 100, peek: true });
    check("peek sees pending without leasing", peek.messages.length === 1 && peek.leaseExpiresAt === null, peek);
    const still = mailbox.get(peek.messages[0]!.id);
    check("peek did not change state", still?.state === "pending" && still?.consumer === null, still);
    mailbox.dispose();
  }

  // ── 5. ack + lease conflict + force ──────────────────────────────────────
  section("5. ack / lease conflict / force");
  {
    const mailbox = new Mailbox({ dir: freshDir(), settings: makeSettings(), startTimers: false, log: () => {} });
    const entry = mailbox.enqueue(makeMessage());
    await mailbox.wait({ consumer: "c1", timeoutMs: 100 });

    const conflict = mailbox.ack(entry.id, { consumer: "c2" });
    check("ack by non-holder → LEASE_HELD_BY_OTHER", conflict.ok === false && conflict.code === "LEASE_HELD_BY_OTHER", conflict);

    const forced = mailbox.ack(entry.id, { consumer: "c2", force: true });
    check("ack --force succeeds", forced.ok === true);
    check("state done / doneBy ack", mailbox.get(entry.id)?.state === "done" && mailbox.get(entry.id)?.doneBy === "ack");

    const again = mailbox.ack(entry.id, { consumer: "c1" });
    check("ack is idempotent", again.ok === true && again.alreadyDone === true, again);
    mailbox.dispose();
  }

  // ── 6. lease expiry → requeue → expire after max redeliveries ───────────
  section("6. lease expiry + redelivery cap");
  {
    let clock = 1_000_000;
    const mailbox = new Mailbox({
      dir: freshDir(),
      settings: makeSettings({ leaseMs: 100, maxRedeliveries: 1 }),
      startTimers: false,
      now: () => clock,
      log: () => {},
    });
    const entry = mailbox.enqueue(makeMessage());

    await mailbox.wait({ consumer: "c1", timeoutMs: 100 });
    clock += 101;
    mailbox.sweep();
    const requeued = mailbox.get(entry.id);
    check("expired lease re-queued", requeued?.state === "pending" && requeued?.redeliveries === 1, requeued);

    await mailbox.wait({ consumer: "c2", timeoutMs: 100 });
    clock += 101;
    mailbox.sweep();
    const expired = mailbox.get(entry.id);
    check("redelivery cap → done/expired", expired?.state === "done" && expired?.doneBy === "expired", expired);
    mailbox.dispose();
  }

  // ── 7. JSONL replay after restart ────────────────────────────────────────
  section("7. restart replay (pending restored, replyable=false)");
  {
    const dir = freshDir();
    const mailbox1 = new Mailbox({ dir, settings: makeSettings(), startTimers: false, log: () => {} });
    const pendingEntry = mailbox1.enqueue(makeMessage({ text: "pending one" }));
    const leasedEntry = mailbox1.enqueue(makeMessage({ text: "leased one" }));
    await mailbox1.wait({ consumer: "c1", timeoutMs: 100 }); // leases the oldest (pendingEntry)
    check("mailbox1 has 1 leased + 1 pending", mailbox1.stats().leased === 1 && mailbox1.stats().pending === 1, mailbox1.stats());
    void leasedEntry;
    mailbox1.dispose();

    const mailbox2 = new Mailbox({ dir, settings: makeSettings(), startTimers: false, log: () => {} });
    const restored = mailbox2.get(pendingEntry.id);
    check("replayed entry is pending", restored?.state === "pending", restored);
    check("replayed entry has no reply handle", restored?.replyable === false);
    check("restart counts a redelivery", restored?.redeliveries === 1, restored?.redeliveries);
    check("both entries restored", mailbox2.stats().pending === 2, mailbox2.stats());
    mailbox2.dispose();
  }

  // ── 8. queue cap drops the oldest pending ────────────────────────────────
  section("8. queue cap");
  {
    const mailbox = new Mailbox({
      dir: freshDir(),
      settings: makeSettings({ maxPending: 2 }),
      startTimers: false,
      log: () => {},
    });
    const first = mailbox.enqueue(makeMessage({ text: "oldest" }));
    mailbox.enqueue(makeMessage({ text: "second" }));
    mailbox.enqueue(makeMessage({ text: "third" }));
    check("oldest dropped", mailbox.get(first.id) === null);
    check("queue holds the newest 2", mailbox.stats().pending === 2, mailbox.stats());
    mailbox.dispose();
  }

  // ── 9. reply handle lifecycle ────────────────────────────────────────────
  section("9. reply handle (single use + TTL)");
  {
    let clock = 5_000_000;
    const mailbox = new Mailbox({
      dir: freshDir(),
      settings: makeSettings(),
      startTimers: false,
      now: () => clock,
      log: () => {},
    });
    const delivered: string[] = [];
    const handle = {
      deliver: async (payload: Record<string, unknown>) => {
        delivered.push(String(payload.text));
      },
      expiresAt: clock + 1000,
    };
    const entry = mailbox.enqueue(makeMessage(), handle);
    check("hasReplyHandle true", mailbox.hasReplyHandle(entry.id));

    const consumed = mailbox.consumeReplyHandle(entry.id);
    check("consume returns the handle", consumed !== null);
    check("second consume is null (single use)", mailbox.consumeReplyHandle(entry.id) === null);

    const entry2 = mailbox.enqueue(makeMessage(), { ...handle, expiresAt: clock + 1000 });
    clock += 1001;
    mailbox.sweep();
    check("expired handle purged", mailbox.hasReplyHandle(entry2.id) === false);
    check("consume after expiry is null", mailbox.consumeReplyHandle(entry2.id) === null);
    mailbox.dispose();
  }

  // ── 10. targets (incl. replay) ───────────────────────────────────────────
  section("10. targets");
  {
    const dir = freshDir();
    const mailbox1 = new Mailbox({ dir, settings: makeSettings(), startTimers: false, log: () => {} });
    mailbox1.enqueue(makeMessage({ target: "mock:c2c:peer1" }));
    mailbox1.enqueue(makeMessage({ target: "mock:c2c:peer1" }));
    mailbox1.enqueue(makeMessage({ channel: "other", target: "other:group:g1" }));
    const targets1 = mailbox1.targets();
    check("two distinct targets", targets1.length === 2, targets1);
    const peer = targets1.find((t) => t.target === "mock:c2c:peer1");
    check("same target aggregated", peer?.count === 2, peer);
    mailbox1.dispose();

    const mailbox2 = new Mailbox({ dir, settings: makeSettings(), startTimers: false, log: () => {} });
    check("targets survive restart (from JSONL)", mailbox2.targets().length === 2, mailbox2.targets());
    check("channel filter works", mailbox2.targets({ channel: "other" }).length === 1);
    mailbox2.dispose();
  }

  // ── 11. media download ───────────────────────────────────────────────────
  section("11. media download");
  {
    const mediaServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    await new Promise<void>((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
    const addr = mediaServer.address() as { port: number };

    const mailbox = new Mailbox({ dir: freshDir(), settings: makeSettings(), startTimers: false, log: () => {} });
    const entry = mailbox.enqueue(makeMessage({
      media: [{ path: null, url: `http://127.0.0.1:${addr.port}/pic.png`, mime: "image/png" }],
    }));

    const deadline = Date.now() + 3000;
    let downloaded: string | null = null;
    while (Date.now() < deadline) {
      downloaded = mailbox.get(entry.id)?.media[0]?.path ?? null;
      if (downloaded) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check("media downloaded to a local path", typeof downloaded === "string" && downloaded.endsWith(".png"), downloaded);

    mediaServer.close();
    mailbox.dispose();
  }

  // ── 12. dispatchInbound integration (enqueue → pull → reply) ─────────────
  section("12. dispatchInbound mailbox integration");
  {
    const configDir = join(tempRoot, "config");
    const configPath = join(configDir, "ocg.json");
    mkdirSync(configDir, { recursive: true });
    process.env.OCG_CONFIG_PATH = configPath;
    writeFileSync(configPath, JSON.stringify({ agentType: "mailbox", channels: { mock: { enabled: true } } }));
    resetMailbox();

    const rawCfg: LiteGatewayConfig = { agentType: "mailbox", channels: { mock: { enabled: true } } };
    const cfg = buildOpenClawConfig(rawCfg);

    const delivered: string[] = [];
    const result = await dispatchInbound({
      ctx: {
        Body: "ping",
        BodyForAgent: "ping",
        From: "mock:c2c:peer1",
        SessionKey: "mock:agent:main:main",
        MessageSid: "p-1",
        ChatType: "direct",
      },
      cfg,
      deliver: async (payload) => {
        delivered.push(String(payload.text));
      },
    });
    check("dispatch returned mailbox:true", result.mailbox === true, result);
    const messageId = String(result.messageId);

    const mailbox = getMailbox();
    check("singleton mailbox created", mailbox !== null);
    const entry = mailbox!.get(messageId);
    check("queued message carries target/sessionKey", entry?.target === "mock:c2c:peer1" && entry?.sessionKey === "mock:agent:main:main", entry);
    check("queued message replyable", entry?.replyable === true, entry);

    const pulled = await mailbox!.wait({ consumer: "agent-1", timeoutMs: 200 });
    check("agent pulled the message", pulled.messages.length === 1 && pulled.messages[0]?.id === messageId);

    const handle = mailbox!.consumeReplyHandle(messageId);
    check("reply handle available", handle !== null);
    await deliverPayloadInChunks(handle!.deliver, { text: "pong" }, { kind: "final", assistantMessageIndex: 0 }, 100);
    mailbox!.markReplied(messageId);
    check("reply delivered through the handle", delivered.join("") === "pong", delivered);
    check("entry done/reply", mailbox!.get(messageId)?.doneBy === "reply", mailbox!.get(messageId));

    // A second dispatch for the same channel also queues (no handle → send-only).
    const result2 = await dispatchInbound({
      ctx: {
        Body: "no deliver fn",
        From: "mock:c2c:peer1",
        SessionKey: "mock:agent:main:main",
      },
      cfg,
    });
    check("dispatch without deliver still queues", result2.mailbox === true);
    check("queued as send-only", getMailbox()!.get(String(result2.messageId))?.replyable === false);

    resetMailbox();
    delete process.env.OCG_CONFIG_PATH;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("");
  if (failures === 0) {
    console.log("✅ All mailbox tests passed!\n");
    process.exitCode = 0;
  } else {
    console.log(`❌ ${failures} mailbox test check(s) failed!\n`);
    process.exitCode = 1;
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

await main();
