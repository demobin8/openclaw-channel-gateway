/**
 * Lite Gateway — Plugin Runtime Factory
 *
 * Builds a comprehensive PluginRuntime object that satisfies OpenClaw
 * channel plugins' runtime requirements. Uses real OpenClaw SDK functions
 * for utilities (command detection, routing, session, etc.) and provides
 * a custom `dispatchReplyFromConfig` that forwards to the configured
 * HTTP agent endpoint instead of running the full OpenClaw agent pipeline.
 *
 * Channels access the runtime to:
 *   - logging.shouldLogVerbose() / getChildLogger()   (debug logging)
 *   - state.openKeyedStore() / openSyncKeyedStore()   (data persistence)
 *   - state.openChannelIngressQueue()                  (inbound msg queue)
 *   - config.replaceConfigFile() / current             (config mutations)
 *   - channel.commands.shouldComputeCommandAuthorized  (command detection)
 *   - channel.routing.resolveAgentRoute                (agent routing)
 *   - channel.session.resolveStorePath                 (session store path)
 *   - channel.reply.finalizeInboundContext             (context normalization)
 *   - channel.reply.dispatchReplyFromConfig            (LLM dispatch — OUR override)
 *   - channel.reply.createReplyDispatcherWithTyping    (typing indicators)
 *   - channel.reply.withReplyDispatcher                (error handling)
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { dispatchInbound } from "../inbound.js";
import { resolveMediaDir } from "../config.js";
import type { DeliverFn } from "../reply-chunking.js";

// ── Imports from real OpenClaw plugin-sdk (loader bypasses interception for shim callers) ──

import {
  resolveAgentRoute,
  buildAgentSessionKey,
} from "openclaw/plugin-sdk/routing";

import {
  resolveStorePath as ocgResolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";

import {
  finalizeInboundContext,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";

// ── command-auth helpers: resilient across OpenClaw releases ─────────────

type SdkModule = Record<string, unknown>;
type SdkFunction = (...args: unknown[]) => unknown;

function isMissingModuleError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || code === "ERR_MODULE_NOT_FOUND";
}

async function importOptionalModule(specifier: string): Promise<SdkModule | undefined> {
  try {
    return (await import(specifier)) as SdkModule;
  } catch (err) {
    if (isMissingModuleError(err)) return undefined;
    throw err;
  }
}

/**
 * OpenClaw moves helpers between plugin-sdk subpaths across releases:
 * `command-auth` was split into `command-detection` / `command-auth-native`
 * in 2026.10. Try every known location and fall back to a local stub, so a
 * host upgrade degrades command handling instead of killing the whole
 * runtime (the gateway does not handle control commands anyway).
 */
function resolveCommandAuthHelper(
  modules: Array<SdkModule | undefined>,
  name: string,
  fallback: SdkFunction,
): SdkFunction {
  for (const mod of modules) {
    const value = mod?.[name];
    if (typeof value === "function") return value as SdkFunction;
  }
  console.warn(`[ocg] openclaw plugin-sdk does not export ${name}; using a local fallback`);
  return fallback;
}

const commandAuthModules = await Promise.all([
  importOptionalModule("openclaw/plugin-sdk/command-auth"),
  importOptionalModule("openclaw/plugin-sdk/command-detection"),
  importOptionalModule("openclaw/plugin-sdk/command-auth-native"),
]);

const shouldComputeCommandAuthorized = resolveCommandAuthHelper(
  commandAuthModules,
  "shouldComputeCommandAuthorized",
  () => false,
);
const resolveCommandAuthorizedFromAuthorizers = resolveCommandAuthHelper(
  commandAuthModules,
  "resolveCommandAuthorizedFromAuthorizers",
  () => false,
);
const isControlCommandMessage = resolveCommandAuthHelper(
  commandAuthModules,
  "isControlCommandMessage",
  () => false,
);

// resolveHumanDelayConfig is in agent-runtime, not reply-runtime.
// Provide a local implementation to avoid pulling in the full agent system.
function resolveHumanDelayConfig(
  cfg: Record<string, unknown>,
  _agentId: string,
): { mode?: string; minMs?: number; maxMs?: number } | undefined {
  const defaults = (cfg.agents as Record<string, unknown>)?.defaults as Record<string, unknown> | undefined;
  const humanDelay = defaults?.humanDelay as { mode?: string; minMs?: number; maxMs?: number } | undefined;
  if (!humanDelay) return undefined;
  return {
    mode: humanDelay.mode,
    minMs: humanDelay.minMs,
    maxMs: humanDelay.maxMs,
  };
}

// ── Types ────────────────────────────────────────────────────────────────

type RuntimeLogger = {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  child?: (bindings: Record<string, unknown>) => RuntimeLogger;
};

type DispatcherOptions = {
  deliver: DeliverFn;
  onError?: (err: Error, info: { kind: string }) => void;
  humanDelay?: { mode?: string; minMs?: number; maxMs?: number };
  beforeDeliver?: (
    payload: Record<string, unknown>,
    meta: { kind: string },
  ) => Promise<Record<string, unknown> | null>;
  responsePrefix?: string;
  responsePrefixContext?: unknown;
  silentReplyContext?: unknown;
  onIdle?: () => void;
  onSkip?: (payload: Record<string, unknown>, info: { kind: string; reason: string }) => void;
  onHeartbeatStrip?: (text: string) => string;
  transformReplyPayload?: (p: Record<string, unknown>) => Record<string, unknown>;
};

type Dispatcher = {
  sendToolResult: (payload: Record<string, unknown>) => boolean;
  sendBlockReply: (payload: Record<string, unknown>) => boolean;
  sendFinalReply: (payload: Record<string, unknown>) => boolean;
  markComplete: () => void;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<string, number>;
  getFailedCounts: () => Record<string, number>;
  getCancelledCounts: () => Record<string, number>;
  appendBeforeDeliver?: (hook: (
    payload: Record<string, unknown>,
    info: { kind: string },
  ) => Promise<Record<string, unknown> | null>) => void;
};

// ── InMemoryStore ────────────────────────────────────────────────────────

class InMemoryStore {
  private data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }
  delete(key: string): boolean {
    return this.data.delete(key);
  }
  keys(): string[] {
    return [...this.data.keys()];
  }
  clear(): void {
    this.data.clear();
  }
}

function createNoopLogger(prefix: string): RuntimeLogger {
  return {
    debug: (msg: string) => console.debug(`[ocg-runtime:${prefix}]`, msg),
    info: (msg: string) => console.log(`[ocg-runtime:${prefix}]`, msg),
    warn: (msg: string) => console.warn(`[ocg-runtime:${prefix}]`, msg),
    error: (msg: string) => console.error(`[ocg-runtime:${prefix}]`, msg),
    child: (_bindings: Record<string, unknown>) => createNoopLogger(prefix),
  };
}

// ── Simple reply dispatcher (no global registry needed) ──────────────────

function createReplyDispatcher(options: DispatcherOptions): Dispatcher {
  let beforeDeliver = options.beforeDeliver;
  let sendChain = Promise.resolve();
  let pending = 1;
  let completeCalled = false;

  const queuedCounts = { tool: 0, block: 0, final: 0 };
  const failedCounts = { tool: 0, block: 0, final: 0 };
  const cancelledCounts = { tool: 0, block: 0, final: 0 };

  const enqueue = (kind: string, payload: Record<string, unknown>): boolean => {
    queuedCounts[kind as keyof typeof queuedCounts] += 1;
    pending += 1;
    sendChain = sendChain
      .then(async () => {
        let deliverPayload: Record<string, unknown> | null = payload;
        if (beforeDeliver) {
          deliverPayload = (await beforeDeliver(payload, { kind })) ?? null;
          if (!deliverPayload) {
            cancelledCounts[kind as keyof typeof cancelledCounts] += 1;
            return;
          }
        }
        await options.deliver(deliverPayload as Record<string, unknown>, { kind });
      })
      .catch((err) => {
        failedCounts[kind as keyof typeof failedCounts] += 1;
        options.onError?.(err instanceof Error ? err : new Error(String(err)), { kind });
      })
      .finally(() => {
        pending -= 1;
        if (pending === 1 && completeCalled) pending -= 1;
        if (pending === 0) options.onIdle?.();
      });
    return true;
  };

  const markComplete = () => {
    if (completeCalled) return;
    completeCalled = true;
    Promise.resolve().then(() => {
      if (pending === 1 && completeCalled) {
        pending -= 1;
        if (pending === 0) options.onIdle?.();
      }
    });
  };

  return {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    markComplete,
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    getFailedCounts: () => ({ ...failedCounts }),
    getCancelledCounts: () => ({ ...cancelledCounts }),
    appendBeforeDeliver: (hook) => {
      const prev = beforeDeliver;
      beforeDeliver = prev
        ? async (p, info) => {
            const r = await prev(p, info);
            return r ? hook(r, info) : null;
          }
        : hook;
    },
  };
}

function createReplyDispatcherWithTyping(options: {
  humanDelay?: { mode?: string; minMs?: number; maxMs?: number };
  typingCallbacks?: {
    onReplyStart?: () => void;
    onIdle?: () => void;
    onCleanup?: () => void;
  };
  deliver: DeliverFn;
  onError?: (err: Error, info: { kind: string }) => void;
  onReplyStart?: () => void;
  onIdle?: () => void;
  onSettled?: () => void;
  onFreshSettledDelivery?: () => void;
  onCleanup?: () => void;
}): {
  dispatcher: Dispatcher;
  replyOptions: {
    onReplyStart?: () => void;
    onTypingCleanup?: () => void;
    onTypingController?: (ctrl: { markDispatchIdle: () => void; markRunComplete: () => void }) => void;
  };
  markDispatchIdle: () => void;
} {
  const { typingCallbacks, onReplyStart, onIdle, onCleanup, ...rest } = options;
  const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
  const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
  const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;

  return {
    dispatcher: createReplyDispatcher({
      ...rest,
      onIdle: () => resolvedOnIdle?.(),
    }),
    replyOptions: {
      onReplyStart: resolvedOnReplyStart,
      onTypingCleanup: resolvedOnCleanup,
      onTypingController: () => {},
    },
    markDispatchIdle: () => resolvedOnIdle?.(),
  };
}

// ── withReplyDispatcher wrapper ──────────────────────────────────────────

async function withReplyDispatcher(params: {
  dispatcher: Dispatcher;
  run: () => Promise<unknown>;
}): Promise<unknown> {
  try {
    return await params.run();
  } finally {
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } catch {
      // ignore
    }
  }
}

// ── settleReplyDispatcher ────────────────────────────────────────────────

async function settleReplyDispatcher(params: {
  dispatcher: Dispatcher;
  onSettled?: () => void;
}): Promise<void> {
  params.dispatcher.markComplete();
  try {
    await params.dispatcher.waitForIdle();
  } finally {
    await params.onSettled?.();
  }
}

// ── dispatchReplyFromConfig → shared inbound dispatch ─────────────────────

/**
 * Our replacement for the OpenClaw agent pipeline.
 *
 * When the WeChat plugin receives a message, `processOneMessage` does auth,
 * routing, session setup, then calls:
 *
 *   channelRuntime.reply.dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions })
 *
 * We intercept that call here and hand it to the shared inbound dispatch
 * (`src/inbound.ts`), which selects the transport (mailbox / ACP / HTTP) and
 * delivers replies back through the dispatcher (which sends them via WeChat).
 *
 * Delivery semantics of this entry (preserved from the pre-1.3.0
 * implementation): block streaming honours `disableBlockStreaming`, and the
 * final payload is skipped when blocks were already delivered.
 */
async function dispatchReplyFromConfig(params: {
  ctx: Record<string, unknown>;
  cfg: Record<string, unknown>;
  dispatcher: Dispatcher;
  replyOptions?: Record<string, unknown>;
}): Promise<{ queuedFinal: boolean; counts: Record<string, number> }> {
  const { ctx, cfg, dispatcher } = params;

  console.log(`[ocg] dispatchReplyFromConfig CALLED, ctx keys:`, Object.keys(ctx).slice(0, 20));
  console.log(`[ocg] dispatchReplyFromConfig Body=${typeof ctx.Body}, BodyForAgent=${typeof ctx.BodyForAgent}, CommandBody=${typeof ctx.CommandBody}, RawBody=${typeof ctx.RawBody}`);

  // Extract user message
  const body =
    (typeof ctx.BodyForAgent === "string" && ctx.BodyForAgent) ||
    (typeof ctx.Body === "string" && ctx.Body) ||
    (typeof ctx.CommandBody === "string" && ctx.CommandBody) ||
    (typeof ctx.RawBody === "string" && ctx.RawBody) ||
    "";

  if (!body.trim()) {
    dispatcher.markComplete();
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }

  // Adapt the dispatcher into a single deliver function. The dispatcher applies
  // its own beforeDeliver hooks and typing lifecycle; block vs final routing is
  // the only thing this adapter decides.
  const deliver: DeliverFn = async (payload, meta) => {
    if (meta.kind === "block") {
      dispatcher.sendBlockReply(payload);
    } else {
      dispatcher.sendFinalReply(payload);
    }
  };

  const result = await dispatchInbound({
    ctx,
    cfg,
    deliver,
    replyOptions: params.replyOptions,
    finalPolicy: "unless-blocks",
  });

  return {
    queuedFinal: result.queuedFinal === true,
    counts: (result.counts as Record<string, number> | undefined) ?? { tool: 0, block: 0, final: 0 },
  };
}

// ── resolveStorePath (fallback) ──────────────────────────────────────────

function resolveStorePath(
  storeCfg: string,
  opts: Record<string, unknown>,
): string {
  try {
    // Try the real OpenClaw resolveStorePath first
    return ocgResolveStorePath(storeCfg, opts);
  } catch {
    // Fallback: temp dir
    const dir = path.resolve(os.tmpdir(), "ocg-sessions", String(opts.sessionKey ?? "default"));
    return dir;
  }
}

// ── saveMediaBuffer ──────────────────────────────────────────────────────
//
// Channel plugins call this the way OpenClaw's media store does — positionally:
//
//   saveMediaBuffer(buffer, contentType?, subdir?, maxBytes?, originalFilename?)
//
// and read `{ path }` back (`openclaw-weixin` stores `saved.path` as
// `ctx.MediaPath`). The previous shim implemented only the object form and
// returned a bare string, so the WeChat plugin's `saveMedia(buf, undefined,
// "inbound", …)` call threw `Cannot read properties of undefined (reading
// 'dir')` and inbound images were silently dropped.
//
// Both call shapes are supported now, and files go to the OCG data dir instead
// of the OS temp dir so they survive restarts:
//
//   <config dir>/media/<subdir>/<timestamp>-<random>.<ext>
//
// The object form's `dir` is an explicit override kept for older callers.

export type SavedMedia = {
  id: string;
  path: string;
  size: number;
  contentType?: string;
};

/** Options accepted by the legacy object-form call. */
export type SaveMediaOptions = {
  /** File-name hint; sanitized and used as the file stem. */
  key?: string;
  /** Explicit target directory (overrides `<media root>/<subdir>`). */
  dir?: string;
  contentType?: string;
  subdir?: string;
  maxBytes?: number;
  originalFilename?: string;
};

/** Default cap, mirroring OpenClaw's media store (explicit `maxBytes` wins). */
const DEFAULT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/heic": ".heic",
  "image/svg+xml": ".svg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/silk": ".silk",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/amr": ".amr",
  "audio/aac": ".aac",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "text/plain": ".txt",
};

function normalizeMime(value: string | undefined): string | undefined {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  return mime || undefined;
}

function extensionFromFilename(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(ext) ? ext : undefined;
}

/**
 * Last-resort extension detection from magic bytes. WeChat images arrive with
 * no content type and no filename, so without this the very case being fixed
 * would land as `.bin` even though the bytes are a valid JPEG/PNG.
 */
function sniffMediaExtension(buffer: Buffer): string | undefined {
  const hasBytes = (...bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);
  const ascii = (start: number, end: number) =>
    buffer.length >= end ? buffer.toString("ascii", start, end) : "";

  if (hasBytes(0xff, 0xd8, 0xff)) return ".jpg";
  if (hasBytes(0x89, 0x50, 0x4e, 0x47)) return ".png";
  if (hasBytes(0x47, 0x49, 0x46, 0x38)) return ".gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  if (hasBytes(0x42, 0x4d)) return ".bmp";
  if (ascii(0, 4) === "%PDF") return ".pdf";
  if (hasBytes(0x50, 0x4b, 0x03, 0x04)) return ".zip";
  if (ascii(4, 8) === "ftyp") return ".mp4";
  return undefined;
}

/** contentType → original filename / key → magic bytes → `.bin`. */
function resolveMediaExtension(
  contentType: string | undefined,
  originalFilename: string | undefined,
  key: string | undefined,
  buffer: Buffer,
): string {
  const mime = normalizeMime(contentType);
  if (mime && MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
  return extensionFromFilename(originalFilename) ??
    extensionFromFilename(key) ??
    sniffMediaExtension(buffer) ??
    ".bin";
}

/** Reject absolute paths and `..` segments so a caller cannot escape the media root. */
function resolveMediaSubdir(subdir: unknown): string {
  if (subdir === undefined || subdir === null) return "";
  if (typeof subdir !== "string") {
    throw new Error(`saveMediaBuffer: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  const raw = subdir.trim();
  if (raw === "" || raw === ".") return "";
  if (raw.includes("\0") || path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[a-zA-Z]:/u.test(raw)) {
    throw new Error(`saveMediaBuffer: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  const segments = raw.split(/[\\/]+/u);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`saveMediaBuffer: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  return path.join(...segments);
}

function resolveMediaTargetDir(opts: SaveMediaOptions): string {
  if (typeof opts.dir === "string" && opts.dir.trim() !== "") {
    return path.resolve(opts.dir);
  }
  const root = resolveMediaDir();
  const relative = resolveMediaSubdir(opts.subdir ?? "inbound");
  const dir = relative ? path.join(root, relative) : root;
  const insideRoot = path.relative(root, dir);
  if (insideRoot.startsWith("..") || path.isAbsolute(insideRoot)) {
    throw new Error(`saveMediaBuffer: media subdir escapes media root: ${JSON.stringify(opts.subdir)}`);
  }
  return dir;
}

function resolveMaxBytes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MEDIA_MAX_BYTES;
}

/** Keep only a short, filesystem-safe stem from a caller-provided key/filename. */
function safeFileStem(value: string): string | undefined {
  const base = path.basename(value).replace(/\.[^.]*$/u, "");
  const stem = base.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 60);
  return stem || undefined;
}

export function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
): Promise<SavedMedia>;
export function saveMediaBuffer(buffer: Buffer, options?: SaveMediaOptions): Promise<SavedMedia>;
export async function saveMediaBuffer(
  buffer: Buffer,
  contentTypeOrOptions?: string | SaveMediaOptions,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
): Promise<SavedMedia> {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("saveMediaBuffer: buffer must be a Buffer");
  }

  const opts: SaveMediaOptions =
    typeof contentTypeOrOptions === "string" || contentTypeOrOptions === undefined
      ? { contentType: contentTypeOrOptions, subdir, maxBytes, originalFilename }
      : contentTypeOrOptions;

  const limit = resolveMaxBytes(opts.maxBytes);
  if (buffer.byteLength > limit) {
    // Checked before mkdir/writeFile: an oversized buffer must not touch disk.
    throw new Error(
      `Media exceeds ${(limit / (1024 * 1024)).toFixed(0)}MB limit ` +
        `(${buffer.byteLength} bytes > ${limit} bytes)`,
    );
  }

  const dir = resolveMediaTargetDir(opts);
  await mkdir(dir, { recursive: true });

  const ext = resolveMediaExtension(opts.contentType, opts.originalFilename, opts.key, buffer);
  const stem = opts.key ? safeFileStem(opts.key) : undefined;
  const random = randomUUID().replace(/-/gu, "").slice(0, 12);
  const id = `${stem ? `${stem}-` : ""}${Date.now()}-${random}${ext}`;
  const filePath = path.resolve(dir, id);
  await writeFile(filePath, buffer);

  return {
    id,
    path: filePath,
    size: buffer.byteLength,
    contentType: normalizeMime(opts.contentType),
  };
}

// ── recordInboundSession (stub) ──────────────────────────────────────────

async function recordInboundSession(_params: Record<string, unknown>): Promise<void> {
  // Stub: no-op
}

// ── Main factory ─────────────────────────────────────────────────────────

/**
 * Create a PluginRuntime object suitable for passing to
 * channel plugins' setRuntime / setChannelRuntime functions.
 *
 * @param dispatchFn - The dispatch reply function for outbound messages
 * @param hostVersion - OpenClaw host version string (e.g. "2026.6.5")
 */
export function createPluginRuntime(
  dispatchFn?: (ctx: Record<string, unknown>) => Promise<unknown>,
  hostVersion = "unknown",
  hostChannelId?: string,
): Record<string, unknown> {
  const stores = new Map<string, InMemoryStore>();

  const logging = {
    shouldLogVerbose: () => process.env.OCG_VERBOSE === "1",
    getChildLogger: (bindings?: Record<string, unknown>) => {
      const prefix = bindings ? JSON.stringify(bindings) : "unknown";
      return createNoopLogger(prefix);
    },
  };

  const state = {
    resolveStateDir: () => ".ocg-state",

    openKeyedStore: <T>(_options: unknown) => {
      const id = randomUUID();
      if (!stores.has(id)) stores.set(id, new InMemoryStore());
      const store = stores.get(id)!;
      return {
        get: (key: string) => Promise.resolve(store.get<T>(key) ?? null),
        set: (key: string, value: T) => {
          store.set(key, value);
          return Promise.resolve();
        },
        delete: (key: string) => {
          store.delete(key);
          return Promise.resolve();
        },
        keys: () => Promise.resolve(store.keys()),
        clear: () => {
          store.clear();
          return Promise.resolve();
        },
        destroy: () => {
          stores.delete(id);
          return Promise.resolve();
        },
      };
    },

    openSyncKeyedStore: <T>(_options: unknown) => {
      const id = randomUUID();
      if (!stores.has(id)) stores.set(id, new InMemoryStore());
      const store = stores.get(id)!;
      return {
        get: (key: string) => store.get<T>(key) ?? null,
        set: (key: string, value: T) => store.set(key, value),
        delete: (key: string) => store.delete(key),
        keys: () => store.keys(),
        clear: () => store.clear(),
      };
    },

    openChannelIngressQueue: () => {
      const queue: Array<{ payload: unknown; ack: () => void }> = [];
      return {
        push: (payload: unknown) => {
          queue.push({ payload, ack: () => {} });
          return Promise.resolve();
        },
        shift: () => {
          const entry = queue.shift();
          return Promise.resolve(entry ?? null);
        },
        length: () => Promise.resolve(queue.length),
      };
    },
  };

  const config = {
    current: {} as Record<string, unknown>,
    replaceConfigFile: (_params: unknown) => Promise.resolve(),
    mutateConfigFile: (_params: unknown) => Promise.resolve(),
    loadConfig: () => Promise.resolve({}),
    writeConfigFile: (_cfg: unknown) => Promise.resolve(),
  };

  // ── Comprehensive channel runtime ─────────────────────────────────────
  // This object mirrors the shape of OpenClaw's `createRuntimeChannel()`
  // (node_modules/openclaw/dist/runtime-channel-Cip35nX1.js) so plugins
  // that destructure deeply (e.g. openclaw-weixin) find everything they need.

  const channel: Record<string, unknown> = {
    // ── text utilities ──────────────────────────────────────────────────
    text: {
      dispatchTextMessage: async () => {},
      chunkByNewline: (text: string, limit: number) => {
        // Simple chunking fallback
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += limit) {
          chunks.push(text.slice(i, i + limit));
        }
        return chunks;
      },
      chunkText: (text: string, limit: number) => {
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += limit) {
          chunks.push(text.slice(i, i + limit));
        }
        return chunks;
      },
      chunkMarkdownText: (text: string, limit: number) => {
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += limit) {
          chunks.push(text.slice(i, i + limit));
        }
        return chunks;
      },
      chunkMarkdownTextWithMode: (text: string, limit: number) => {
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += limit) {
          chunks.push(text.slice(i, i + limit));
        }
        return chunks;
      },
      chunkTextWithMode: (text: string, limit: number) => {
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += limit) {
          chunks.push(text.slice(i, i + limit));
        }
        return chunks;
      },
      resolveChunkMode: () => "newline",
      resolveTextChunkLimit: () => 4096,
      hasControlCommand: () => false,
      resolveMarkdownTableMode: () => "auto",
      convertMarkdownTables: (text: string) => text,
    },

    // ── reply pipeline ──────────────────────────────────────────────────
    reply: {
      dispatchReplyWithBufferedBlockDispatcher:
        dispatchFn ??
        (async (_ctx: Record<string, unknown>) => {
          console.warn("[ocg] dispatchReplyWithBufferedBlockDispatcher not set");
        }),
      createReplyDispatcherWithTyping,
      resolveEffectiveMessagesConfig: () => ({}),
      resolveHumanDelayConfig,
      dispatchReplyFromConfig,
      withReplyDispatcher,
      settleReplyDispatcher,
      finalizeInboundContext,
      formatAgentEnvelope: (text: string) => text,
      formatInboundEnvelope: (ctx: Record<string, unknown>) => String(ctx.Body ?? ""),
      resolveEnvelopeFormatOptions: () => ({}),
    },

    // ── routing ─────────────────────────────────────────────────────────
    routing: {
      buildAgentSessionKey,
      resolveAgentRoute,
    },

    // ── pairing ─────────────────────────────────────────────────────────
    pairing: {
      buildPairingReply: () => null,
      readAllowFromStore: async () => [],
      upsertPairingRequest: async () => {},
    },

    // ── media ───────────────────────────────────────────────────────────
    media: {
      readRemoteMediaBuffer: async () => null,
      fetchRemoteMedia: async () => null,
      saveRemoteMedia: async () => "",
      saveResponseMedia: async () => "",
      saveMediaBuffer,
    },

    // ── activity ────────────────────────────────────────────────────────
    activity: {
      record: () => {},
      get: () => null,
    },

    // ── session ─────────────────────────────────────────────────────────
    session: {
      resolveStorePath,
      readSessionUpdatedAt: () => null,
      recordSessionMetaFromInbound: () => Promise.resolve(),
      recordInboundSession,
      updateLastRoute: () => Promise.resolve(),
    },

    // ── mentions ────────────────────────────────────────────────────────
    mentions: {
      buildMentionRegexes: () => [],
      matchesMentionPatterns: () => false,
      matchesMentionWithExplicit: () => false,
      implicitMentionKindWhen: () => null,
      resolveInboundMentionDecision: () => ({ mentioned: false }),
    },

    // ── reactions ───────────────────────────────────────────────────────
    reactions: {
      createAckReactionHandle: () => null,
      shouldAckReaction: () => false,
      removeAckReactionAfterReply: () => {},
      removeAckReactionHandleAfterReply: () => {},
    },

    // ── groups ──────────────────────────────────────────────────────────
    groups: {
      resolveGroupPolicy: () => ({}),
      resolveRequireMention: () => false,
    },

    // ── debounce ────────────────────────────────────────────────────────
    debounce: {
      createInboundDebouncer: () => ({
        shouldDebounce: () => false,
        markSent: () => {},
      }),
      resolveInboundDebounceMs: () => 0,
    },

    // ── commands ────────────────────────────────────────────────────────
    commands: {
      resolveCommandAuthorizedFromAuthorizers,
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands: () => false,
    },

    // ── outbound ────────────────────────────────────────────────────────
    outbound: {
      loadAdapter: () => null,
    },

    // ── inbound ─────────────────────────────────────────────────────────
    inbound: {
      buildContext: () => ({}),
      /**
       * Simplified inbound.run — called by channel plugins (QQ Bot, etc.)
       * to process an incoming message through the agent dispatch pipeline.
       *
       * Mimics the real runChannelTurn from openclaw/kernel but skips
       * command routing, session tracking, and other host-level features.
       */
      run: async (params: Record<string, unknown>) => {
        const adapter = params.adapter as Record<string, unknown> | undefined;
        if (!adapter || typeof adapter.ingest !== "function") {
          console.warn("[ocg] inbound.run: no adapter.ingest, skipping");
          return { admission: { kind: "drop", reason: "no-adapter" }, dispatched: false };
        }

        const ingestFn = adapter.ingest as (raw: unknown) => Record<string, unknown>;
        const input = ingestFn(params.raw);
        if (!input) {
          console.warn("[ocg] inbound.run: ingest returned null, skipping");
          return { admission: { kind: "drop", reason: "ingest-null" }, dispatched: false };
        }

        const effectiveHostChannelId = typeof params.channelId === "string" ? params.channelId : hostChannelId;
        if (effectiveHostChannelId && typeof input === "object" && input !== null && !("channelId" in input)) {
          (input as Record<string, unknown>).channelId = effectiveHostChannelId;
        }

        console.log(`[ocg] inbound.run: message from adapter, id=${input.id}, channelId=${effectiveHostChannelId ?? "(unknown)"}, textForAgent=${String(input.textForAgent ?? "").slice(0, 60)}`);

        // Call resolveTurn to get the dispatch function
        const resolveTurnFn = adapter.resolveTurn as
          | ((input: Record<string, unknown>, eventClass: unknown, preflight: unknown) => Record<string, unknown>)
          | undefined;

        if (!resolveTurnFn) {
          console.warn("[ocg] inbound.run: no adapter.resolveTurn, skipping");
          return { admission: { kind: "drop", reason: "no-resolveTurn" }, dispatched: false };
        }

        const resolved = resolveTurnFn(input, null, null);

        // Execute the dispatch
        if (typeof resolved.runDispatch === "function") {
          try {
            const dispatchFn = resolved.runDispatch as () => Promise<unknown>;
            await dispatchFn();
            return { admission: { kind: "dispatch" }, dispatched: true };
          } catch (err) {
            console.error("[ocg] inbound.run dispatch error:", err);
            return { admission: { kind: "dispatch" }, dispatched: false };
          }
        }

        console.warn("[ocg] inbound.run: no runDispatch in resolved turn");
        return { admission: { kind: "drop", reason: "no-dispatch" }, dispatched: false };
      },
      runPreparedReply: async () => {},
      dispatchReply: async () => {},
    },

    // ── threadBindings ──────────────────────────────────────────────────
    threadBindings: {
      setIdleTimeoutBySessionKey: () => {},
      setMaxAgeBySessionKey: () => {},
    },

    // ── runtimeContexts (registry stub) ──────────────────────────────────
    runtimeContexts: {
      register: () => ({ dispose: () => {} }),
      get: () => undefined,
      watch: () => () => {},
    },
  };

  // Event emitter stub
  const events = {
    on: (_event: string, _handler: (...args: unknown[]) => void) => {},
    off: (_event: string, _handler: (...args: unknown[]) => void) => {},
    emit: (_event: string, ..._args: unknown[]) => {},
    onAgentEvent: () => {},
    onSessionTranscriptUpdate: () => {},
    onChannelIngress: (_handler: (payload: unknown) => void) => {},
  };

  // Top-level log/error convenience for monitors that access runtime.log / runtime.error
  const monLog = (msg: string) => console.log(`[ocg-weixin] ${msg}`);
  const monErr = (msg: string) => console.error(`[ocg-weixin] ${msg}`);

  return {
    version: hostVersion,
    logging,
    log: monLog,
    error: monErr,
    state,
    config,
    channel,
    events,
    // Top-level stubs for plugins that destructure directly
    agent: { defaults: {}, resolveAgentDir: () => "" },
    system: { enqueueSystemEvent: () => {}, requestHeartbeat: () => {} },
    media: { loadWebMedia: async () => null, detectMime: async () => "" },
    tts: { textToSpeech: async () => null },
    mediaUnderstanding: {
      describeImageFileWithModel: async () => ({ description: "" }),
      runFile: async () => null,
    },
    imageGeneration: { generate: async () => null, listProviders: () => [] },
    videoGeneration: { generate: async () => null, listProviders: () => [] },
    musicGeneration: { generate: async () => null, listProviders: () => [] },
    webSearch: { search: async () => [], listProviders: () => [] },
    stt: { transcribeAudioFile: async () => ({ text: "" }) },
    subagent: {
      run: async () => ({}),
      waitForRun: async () => ({}),
      getSessionMessages: async () => [],
    },
    nodes: { list: () => [], invoke: async () => null },
    tasks: { runs: {}, flows: {}, managedFlows: {}, flow: {} },
    taskFlow: {},
    modelAuth: {
      getApiKeyForModel: () => "",
      getRuntimeAuthForModel: () => "",
      resolveApiKeyForProvider: () => "",
    },
    llm: { complete: async () => ({ content: "" }) },
  };
}
