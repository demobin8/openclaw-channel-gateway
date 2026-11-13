/**
 * Regression tests for the plugin-runtime media shim.
 *
 * `openclaw-weixin` calls `channelRuntime.media.saveMediaBuffer` positionally
 * (`buffer, contentType?, subdir?, maxBytes?, originalFilename?`) and reads
 * `saved.path`. The shim used to accept only an options object and return a
 * bare string, so WeChat inbound images died with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'dir')
 *
 * Run: npx tsx src/media-test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Point the OCG config (and therefore the media root) at a temp dir before
// importing any module that reads it.
const dataDir = mkdtempSync(join(tmpdir(), "ocg-media-test-"));
process.env.OCG_CONFIG_PATH = join(dataDir, "ocg.json");

const { saveMediaBuffer, createPluginRuntime } = await import("./shims/runtime.js");
const { resolveMediaDir } = await import("./config.js");
const { ensureMailbox, resetMailbox } = await import("./mailbox.js");

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

async function expectError(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("ocg-media-test-image"),
]);

const mediaRoot = resolveMediaDir();

// ── Positional call (what openclaw-weixin does) ─────────────────────────────
section("positional call returns { path } and writes bytes");

const positional = await saveMediaBuffer(PNG_BYTES, "image/png", "inbound", 1024 * 1024);
check("returns an object with a string path", typeof positional?.path === "string", positional);
check("id is the file name", positional.id === positional.path.split(/[\\/]/u).pop(), {
  id: positional.id,
  path: positional.path,
});
check(
  "path is under <data dir>/media/inbound",
  dirname(positional.path) === join(mediaRoot, "inbound"),
  { path: positional.path, expectedDir: join(mediaRoot, "inbound") },
);
check("extension inferred from contentType", positional.path.endsWith(".png"), positional.path);
check("file exists", existsSync(positional.path));
check("written bytes match the input", readFileSync(positional.path).equals(PNG_BYTES));

// The exact WeChat image shape: contentType is undefined, no filename.
const weixinStyle = await saveMediaBuffer(PNG_BYTES, undefined, "inbound", 100 * 1024 * 1024);
check("accepts undefined contentType (weixin image)", typeof weixinStyle.path === "string", {
  path: weixinStyle.path,
});
check("sniffs PNG when no contentType/filename", weixinStyle.path.endsWith(".png"), weixinStyle.path);
check("file is a readable image copy", readFileSync(weixinStyle.path).equals(PNG_BYTES));

// ── Object call (legacy OCG callers) ────────────────────────────────────────
section("object call stays supported");

const overrideDir = join(dataDir, "override");
const objectCall = await saveMediaBuffer(Buffer.from("notes"), { key: "note.txt", dir: overrideDir });
check("returns an object with a string path", typeof objectCall?.path === "string", objectCall);
check("honours the explicit dir", dirname(objectCall.path) === overrideDir, {
  path: objectCall.path,
  expectedDir: overrideDir,
});
check("uses the key extension", objectCall.path.endsWith(".txt"), objectCall.path);
check("sanitizes a traversal key", !objectCall.path.includes(".."), objectCall.path);
check("file exists", existsSync(objectCall.path));

const objectDefaultDir = await saveMediaBuffer(PNG_BYTES, { key: "default.png" });
check(
  "object call without dir uses <media root>/inbound",
  dirname(objectDefaultDir.path) === join(mediaRoot, "inbound"),
  objectDefaultDir.path,
);

// ── Extension inference ────────────────────────────────────────────────────
section("extension inference");

const gif = await saveMediaBuffer(Buffer.from("GIF89a"), "image/gif");
check("contentType mapping", gif.path.endsWith(".gif"), gif.path);

const wav = await saveMediaBuffer(Buffer.from("RIFF"), undefined, "inbound", 1024, "voice.WAV");
check("original filename (case-insensitive)", wav.path.endsWith(".wav"), wav.path);

const jpeg = await saveMediaBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), undefined, "inbound");
check("magic-byte sniffing", jpeg.path.endsWith(".jpg"), jpeg.path);

const bin = await saveMediaBuffer(Buffer.from("not-a-known-format"), "application/octet-stream");
check("falls back to .bin", bin.path.endsWith(".bin"), bin.path);

const noSubdir = await saveMediaBuffer(Buffer.from("plain"), "text/plain");
check(
  "default subdir is inbound",
  dirname(noSubdir.path) === join(mediaRoot, "inbound"),
  noSubdir.path,
);

// ── Size limit ─────────────────────────────────────────────────────────────
section("maxBytes is enforced before writing");

const oversizedDir = join(dataDir, "oversized");
const sizeError = await expectError(() =>
  saveMediaBuffer(Buffer.alloc(64, 1), { dir: oversizedDir, maxBytes: 16 }),
);
check("throws on an oversized buffer", sizeError !== null, sizeError?.message);
check(
  "message mentions the limit",
  (sizeError?.message ?? "").includes("exceeds"),
  sizeError?.message,
);
check("does not create the target dir", !existsSync(oversizedDir));

const positionalSizeError = await expectError(() =>
  saveMediaBuffer(Buffer.alloc(64, 1), "image/png", "inbound", 8),
);
check("positional maxBytes also enforced", positionalSizeError !== null, positionalSizeError?.message);

// ── Path safety ────────────────────────────────────────────────────────────
section("unsafe subdirs are rejected");

const traversalError = await expectError(() =>
  saveMediaBuffer(PNG_BYTES, "image/png", "../escape"),
);
check("rejects '..' subdir", traversalError !== null, traversalError?.message);

const absoluteError = await expectError(() =>
  saveMediaBuffer(PNG_BYTES, "image/png", join(dataDir, "absolute")),
);
check("rejects absolute subdir", absoluteError !== null, absoluteError?.message);

// ── Media-only dispatch reaches the mailbox ────────────────────────────────
section("media-only dispatch enqueues into the mailbox");

const runtime = createPluginRuntime(undefined, "test", "openclaw-weixin");
const reply = (runtime.channel as Record<string, Record<string, unknown>>).reply;
const dispatch = reply.dispatchReplyFromConfig as (params: {
  ctx: Record<string, unknown>;
  cfg: Record<string, unknown>;
  dispatcher: Record<string, unknown>;
}) => Promise<{ queuedFinal: boolean; counts: Record<string, number> }>;

const dispatcher = {
  sendToolResult: () => true,
  sendBlockReply: () => true,
  sendFinalReply: () => true,
  markComplete: () => {},
  waitForIdle: async () => {},
  getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
  getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
  getCancelledCounts: () => ({ tool: 0, block: 0, final: 0 }),
};

const baseCtx = {
  From: "openclaw-weixin:direct:test-user",
  To: "test-user",
  AccountId: "test-account",
  ChatType: "direct",
  SessionKey: "agent:main:openclaw-weixin:test-account:direct:test-user",
};

// WeChat images arrive with an empty Body and only MediaPath/MediaType set.
const mediaOnly = await dispatch({
  ctx: { ...baseCtx, MediaPath: weixinStyle.path, MediaType: "image/*" },
  cfg: { liteGateway: { agentType: "mailbox" } },
  dispatcher,
});
check("returns without a queued final", mediaOnly.queuedFinal === false, mediaOnly);

const mailbox = ensureMailbox();
const stats = mailbox.stats();
check("one pending mailbox entry", stats.pending === 1, stats);
const pending = mailbox.list({ states: ["pending"], limit: 10 });
const entry = pending.find((item) => item.media.some((media) => media.path === weixinStyle.path));
check("entry carries media[].path", entry !== undefined, pending);
check("entry has no text", entry?.text === "", entry?.text);
check("entry keeps the channel id", entry?.channel === "openclaw-weixin", entry?.channel);

if (entry) mailbox.ack(entry.id, { force: true });
check("ack clears the pending entry", mailbox.stats().pending === 0, mailbox.stats());
resetMailbox();

// The old guard still applies when there is neither text nor media.
const empty = await dispatch({
  ctx: { ...baseCtx },
  cfg: { liteGateway: { agentType: "mailbox" } },
  dispatcher,
});
check("empty text and media is a no-op", empty.queuedFinal === false, empty);
check("no mailbox entry for an empty message", ensureMailbox().stats().pending === 0);
resetMailbox();

// ── Cleanup ────────────────────────────────────────────────────────────────
delete process.env.OCG_CONFIG_PATH;
rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "✅ All media shim tests passed!" : `❌ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
