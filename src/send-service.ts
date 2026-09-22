/**
 * Proactive send service (OCG 1.2.0).
 *
 * External callers (agent backend via `POST /ocg/send`, operators via
 * `ocg send`) hand us "channel + account + target + text (optional media)"
 * and we deliver it to the IM platform.
 *
 * Responsibilities split (see docs/requirements-proactive-send.md §3.7):
 *
 * - **Send primitives live in the plugin** (`plugin.outbound.sendText` /
 *   `sendMedia`) — account resolution, platform auth, media handling.
 * - **The orchestration layer lives here** — because the plugin primitives
 *   expect ALREADY-chunked, ALREADY-sanitized text. OpenClaw does that in its
 *   delivery pipeline; OCG does it here, using the plugin's declarations
 *   (`sanitizeText` / `chunker` / `chunkerMode` / `textChunkLimit` /
 *   `resolveEffectiveTextChunkLimit`) plus the public SDK chunking helpers as a
 *   fallback.
 *
 * Deliberately stateless: no queue, no retry, no idempotency store.
 */

import type { SendSettings } from "./config.js";
import { resolveReplyChunkSize, splitReplyText } from "./reply-chunking.js";
import type {
  ChannelOutboundAdapterLike,
  ChannelPluginObject,
  OutboundDeliveryResultLike,
  ResolvedAccount,
} from "./plugin-loader.js";
import { ensureChannelPluginLoaded, getChannelPlugin } from "./plugin-loader.js";

// ── OpenClaw SDK chunking helpers (loaded lazily, with a built-in fallback) ──

/**
 * The SDK surface OCG uses from `openclaw/plugin-sdk/reply-chunking`.
 *
 * Loaded lazily and treated as optional: upstream has already removed public
 * entries once (`plugin-sdk/outbound-runtime` disappeared in openclaw 2026.9.5),
 * so a rename must not take down every `ocg` command at process start. Without
 * it we fall back to the plugin's own `chunker` declaration or, failing that,
 * OCG's built-in splitter.
 */
export type SdkChunking = {
  chunkTextWithMode: (text: string, limit: number, mode: ChunkMode) => string[];
  chunkMarkdownTextWithMode: (text: string, limit: number, mode: ChunkMode) => string[];
  resolveChunkMode: (cfg: unknown, provider?: string, accountId?: string | null) => ChunkMode;
  resolveTextChunkLimit: (
    cfg: unknown,
    provider?: string,
    accountId?: string | null,
    opts?: { fallbackLimit?: number },
  ) => number;
};

let sdkChunkingPromise: Promise<SdkChunking | null> | null = null;
let sdkChunkingWarned = false;

/** Load the SDK chunking helpers once per process; null when unavailable. */
export function loadSdkChunking(): Promise<SdkChunking | null> {
  if (!sdkChunkingPromise) {
    sdkChunkingPromise = import("openclaw/plugin-sdk/reply-chunking")
      .then((mod) => mod as unknown as SdkChunking)
      .catch((err: unknown) => {
        if (!sdkChunkingWarned) {
          sdkChunkingWarned = true;
          console.warn(
            "[ocg] openclaw plugin-sdk chunking helpers unavailable " +
            `(${(err as Error).message}); using built-in chunking`,
          );
        }
        return null;
      });
  }
  return sdkChunkingPromise;
}

// ── Types ──────────────────────────────────────────────────────────────────

/** Raw request payload (HTTP body or CLI flags). Fields are validated here. */
export type SendRequest = {
  channel?: unknown;
  accountId?: unknown;
  to?: unknown;
  text?: unknown;
  mediaUrl?: unknown;
  replyToId?: unknown;
  clientRef?: unknown;
};

/** Injectable seams (tests pass mocks; production uses the defaults). */
export type SendDeps = {
  getPlugin?: (channelId: string) => ChannelPluginObject | null;
  loadPlugin?: (channelId: string) => Promise<ChannelPluginObject | null>;
  /** Override the optional SDK chunking helpers (tests simulate their absence). */
  loadSdkChunking?: () => Promise<SdkChunking | null>;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
};

export type SendOutcome = {
  httpStatus: number;
  body: Record<string, unknown>;
};

type ChunkMode = "length" | "newline";
type ChunkerMode = "text" | "markdown";

/** Worst-case width of the "[12/34]\n" prefix used when chunkPrefix is on. */
const CHUNK_PREFIX_RESERVE = 10;

// ── Helpers ────────────────────────────────────────────────────────────────

function defaultLog(line: Record<string, unknown>): void {
  console.log(`[ocg:send] ${JSON.stringify(line)}`);
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function errorMessage(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (value instanceof Error) return value.message;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested = errorMessage(record.message) ?? errorMessage(record.error);
    if (nested) {
      const code = errorMessage(record.code);
      return code ? `${code}: ${nested}` : nested;
    }
  }
  return undefined;
}

/**
 * Failure detection follows the plugin contract, not exception semantics:
 * qqbot and friends RETURN `{ error }` / `{ meta: { error } }` instead of
 * throwing (requirements doc §3.7.4, decision D11).
 */
function extractSendError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as OutboundDeliveryResultLike;
  return errorMessage(record.error) ?? errorMessage(record.meta?.error);
}

/** Best-effort platform error code extraction (optional field, never required). */
function extractPlatformCode(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const qualified = message.match(/(?:code|err(?:or)?[_ ]?code)\D{0,4}(\d{3,6})/i);
  if (qualified) return qualified[1];
  const leading = message.match(/(?:^|\D)(\d{4,6})(?:\D|$)/);
  return leading?.[1];
}

/** Mask a target down to "channel:kind:***" for responses and logs. */
export function maskTarget(to: string): string {
  const parts = to.split(":").filter((part) => part !== "");
  if (parts.length >= 3) return `${parts[0]}:${parts[1]}:***`;
  if (parts.length === 2) return `${parts[0]}:***`;
  return "***";
}

function isConfiguredValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function resolveAccountForSend(
  plugin: ChannelPluginObject,
  cfg: Record<string, unknown>,
  channel: string,
  accountId: string,
): Promise<{ ok: true; account: ResolvedAccount } | { ok: false; reason: string }> {
  const adapter = plugin.config;
  let account: ResolvedAccount | undefined;

  if (adapter?.resolveAccount) {
    try {
      account = adapter.resolveAccount(cfg, accountId);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  } else {
    // No config adapter: mirror the loader's fallback (channel-level section).
    const section = (cfg.channels as Record<string, Record<string, unknown>> | undefined)?.[channel];
    if (!section) return { ok: false, reason: `channel "${channel}" not configured` };
    account = { accountId, enabled: section.enabled !== false, ...section };
  }

  if (!account) return { ok: false, reason: `account "${accountId}" not found` };

  if (adapter?.isConfigured) {
    let configured: boolean | Promise<boolean>;
    try {
      configured = adapter.isConfigured(account, cfg);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    const resolved = configured instanceof Promise ? await configured : configured;
    if (resolved === false) {
      const reason = adapter.unconfiguredReason?.(account, cfg) ?? "account not configured";
      return { ok: false, reason };
    }
  }

  const enabled = adapter?.isEnabled ? isConfiguredValue(adapter.isEnabled(account, cfg)) : undefined;
  if (enabled === false) return { ok: false, reason: `account "${accountId}" is disabled` };

  return { ok: true, account };
}

type TargetResolution =
  | { ok: true; to: string; validated: boolean; note?: string }
  | { ok: false; error: string; hint?: string };

/**
 * Target resolution degradation chain (requirements doc FR-3):
 *   ① messaging.normalizeTarget → ② custom resolveTarget → ③ looksLikeId
 *   shape check → ④ no declarations at all: hand the value to the platform.
 */
async function resolveTargetForSend(
  plugin: ChannelPluginObject,
  outbound: ChannelOutboundAdapterLike,
  cfg: Record<string, unknown>,
  to: string,
  accountId: string,
): Promise<TargetResolution> {
  const messaging = plugin.messaging;
  let normalized = to;
  let validated = false;

  if (typeof messaging?.normalizeTarget === "function") {
    try {
      const candidate = messaging.normalizeTarget(to);
      if (typeof candidate === "string" && candidate.trim() !== "") normalized = candidate.trim();
    } catch {
      // Normalization is best-effort; keep the raw value.
    }
  }

  const customResolver = outbound.resolveTarget ?? messaging?.targetResolver?.resolveTarget;
  if (typeof customResolver === "function") {
    try {
      const resolved = await Promise.resolve(
        customResolver({ cfg, to: normalized, accountId, mode: "send" }),
      );
      if (resolved && typeof resolved === "object") {
        if ((resolved as { ok?: unknown }).ok === true) {
          const value = (resolved as { to?: unknown }).to;
          if (typeof value === "string" && value.trim() !== "") {
            normalized = value.trim();
            validated = true;
          }
        } else if ((resolved as { ok?: unknown }).ok === false) {
          const error = (resolved as { error?: unknown }).error;
          return {
            ok: false,
            error: errorMessage(error) ?? "target rejected by channel resolver",
            hint: messaging?.targetResolver?.hint,
          };
        }
      }
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        hint: messaging?.targetResolver?.hint,
      };
    }
  }

  const looksLikeId = messaging?.targetResolver?.looksLikeId;
  if (typeof looksLikeId === "function") {
    let matches = false;
    try {
      matches = looksLikeId(normalized, normalized) === true;
    } catch {
      matches = false;
    }
    if (!matches) {
      return {
        ok: false,
        error: "target does not match the channel's target format",
        hint: messaging?.targetResolver?.hint,
      };
    }
    validated = true;
  }

  return validated
    ? { ok: true, to: normalized, validated }
    : { ok: true, to: normalized, validated, note: "channel declares no target validation" };
}

function resolveChunkLimit(
  outbound: ChannelOutboundAdapterLike,
  cfg: Record<string, unknown>,
  channel: string,
  accountId: string,
  sdk: SdkChunking | null,
): number {
  const declared = typeof outbound.textChunkLimit === "number" && outbound.textChunkLimit > 0
    ? Math.floor(outbound.textChunkLimit)
    : undefined;
  const configured = declared ?? resolveReplyChunkSize(undefined);

  let limit = configured;
  if (sdk) {
    try {
      limit = sdk.resolveTextChunkLimit(cfg, channel, accountId, { fallbackLimit: configured });
    } catch {
      // SDK helper failed for this config — the declared limit is authoritative.
    }
  }
  if (!Number.isFinite(limit) || limit <= 0) limit = configured;

  if (typeof outbound.resolveEffectiveTextChunkLimit === "function") {
    try {
      const effective = outbound.resolveEffectiveTextChunkLimit({
        cfg,
        accountId,
        fallbackLimit: limit,
      });
      if (typeof effective === "number" && effective > 0) limit = Math.floor(effective);
    } catch {
      // Keep the configured limit.
    }
  }

  return Math.max(1, Math.floor(limit));
}

function resolveAdapterChunkMode(outbound: ChannelOutboundAdapterLike): ChunkerMode {
  if (outbound.chunkerMode === "markdown" || outbound.chunkerMode === "text") {
    return outbound.chunkerMode;
  }
  return outbound.chunker ? "markdown" : "text";
}

function splitIntoChunks(
  outbound: ChannelOutboundAdapterLike,
  text: string,
  limit: number,
  mode: ChunkerMode,
  softMode: ChunkMode,
  sdk: SdkChunking | null,
): string[] {
  if (text === "") return [];
  if (Array.from(text).length <= limit) return [text];

  if (typeof outbound.chunker === "function") {
    try {
      const chunked = outbound.chunker(text, limit);
      if (Array.isArray(chunked) && chunked.length > 0 && chunked.every((c) => typeof c === "string")) {
        return chunked;
      }
    } catch {
      // Fall through to the SDK helpers / built-in splitter.
    }
  }

  if (sdk) {
    try {
      return mode === "markdown"
        ? sdk.chunkMarkdownTextWithMode(text, limit, softMode)
        : sdk.chunkTextWithMode(text, limit, softMode);
    } catch {
      // Fall through to the built-in splitter.
    }
  }

  // Last resort: OCG's own splitter (the one the reply path uses).
  return splitReplyText(text, limit);
}

function withChunkPrefix(chunks: string[]): string[] {
  const total = chunks.length;
  return chunks.map((chunk, index) => `[${index + 1}/${total}]\n${chunk}`);
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    // The in-flight send keeps running after a timeout; callers must treat the
    // result as "unknown" rather than "not sent" (requirements doc FR-4 B9).
    const raced = await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
    return raced;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Main entry ─────────────────────────────────────────────────────────────

/**
 * Validate + deliver one proactive message.
 *
 * Returns an HTTP-ish outcome so both transports (`/ocg/send`, `ocg send`)
 * share identical semantics.
 */
export async function executeSend(params: {
  cfg: Record<string, unknown>;
  settings: SendSettings;
  request: SendRequest;
  channelEnabled?: boolean;
  deps?: SendDeps;
}): Promise<SendOutcome> {
  const { cfg, settings, request } = params;
  const deps = params.deps ?? {};
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? Date.now;
  const getPlugin = deps.getPlugin ?? getChannelPlugin;
  const loadPlugin = deps.loadPlugin ?? ensureChannelPluginLoaded;
  const startedAt = now();

  const channel = asTrimmedString(request.channel) ?? "";
  const to = asTrimmedString(request.to) ?? "";
  const accountId = asTrimmedString(request.accountId) ?? "default";
  const mediaUrl = asTrimmedString(request.mediaUrl);
  const replyToId = asTrimmedString(request.replyToId);
  const clientRef = typeof request.clientRef === "string" ? request.clientRef : null;
  const rawText = typeof request.text === "string" ? request.text : "";

  const baseLog: Record<string, unknown> = {
    channel: channel || null,
    accountId,
    to: to ? maskTarget(to) : null,
    textLength: rawText.length,
    media: Boolean(mediaUrl),
    clientRef,
  };

  const fail = (
    httpStatus: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): SendOutcome => {
    log({
      ...baseLog,
      ok: false,
      errorCode: code,
      elapsedMs: now() - startedAt,
      ...extra,
    });
    return {
      httpStatus,
      body: { ok: false, code, message, ...extra, elapsedMs: now() - startedAt },
    };
  };

  if (params.channelEnabled === false) {
    return fail(403, "DISABLED", "proactive send is disabled");
  }
  if (!settings.enabled) {
    return fail(
      403,
      "DISABLED",
      "proactive send is disabled: configure sendSecret or callbackSecret to enable it",
    );
  }
  if (!channel || !to) {
    return fail(400, "INVALID_REQUEST", "channel and to are required");
  }
  if (rawText.trim() === "" && !mediaUrl) {
    return fail(400, "INVALID_REQUEST", "text or mediaUrl is required");
  }
  if (settings.allowedChannels && !settings.allowedChannels.includes(channel)) {
    return fail(404, "UNKNOWN_CHANNEL", `channel "${channel}" is not in sendAllowedChannels`);
  }

  const channels = cfg.channels as Record<string, unknown> | undefined;
  const channelSection = channels?.[channel];
  if (!channelSection) {
    return fail(404, "UNKNOWN_CHANNEL", `unknown channel "${channel}"`);
  }

  // ── Plugin + outbound adapter ────────────────────────────────────────────
  let plugin = getPlugin(channel);
  if (!plugin) {
    try {
      plugin = await loadPlugin(channel);
    } catch (err) {
      return fail(503, "NOT_READY", `failed to load channel plugin: ${(err as Error).message}`);
    }
  }
  if (!plugin) {
    return fail(503, "NOT_READY", `channel plugin "${channel}" is not loaded`);
  }

  const outbound = plugin.outbound;
  if (!outbound || typeof outbound.sendText !== "function") {
    return fail(501, "NO_OUTBOUND_ADAPTER", `channel "${channel}" has no outbound adapter`);
  }

  // ── Account ─────────────────────────────────────────────────────────────
  const account = await resolveAccountForSend(plugin, cfg, channel, accountId);
  if (!account.ok) {
    return fail(400, "UNKNOWN_ACCOUNT", account.reason);
  }

  // ── Target ──────────────────────────────────────────────────────────────
  const target = await resolveTargetForSend(plugin, outbound, cfg, to, accountId);
  if (!target.ok) {
    return fail(
      400,
      "INVALID_TARGET",
      target.error,
      target.hint ? { hint: target.hint } : {},
    );
  }

  // ── Media plan (decide before chunking: the degraded path rewrites text) ──
  const canSendMedia = typeof outbound.sendMedia === "function";
  const degraded = Boolean(mediaUrl && !canSendMedia);
  let text = rawText;
  let media = mediaUrl;

  if (mediaUrl && !canSendMedia) {
    text = text.trim() === "" ? mediaUrl : `${text}\n${mediaUrl}`;
    media = null;
  }

  // ── Sanitize ────────────────────────────────────────────────────────────
  if (typeof outbound.sanitizeText === "function" && text.trim() !== "") {
    try {
      const sanitized = outbound.sanitizeText({ text, payload: { text } });
      if (typeof sanitized === "string") text = sanitized;
    } catch (err) {
      log({ ...baseLog, warn: `sanitizeText failed: ${(err as Error).message}` });
    }
  }
  if (text.trim() === "" && !media) {
    return fail(400, "INVALID_REQUEST", "text is empty after sanitization");
  }

  if (settings.maxTextLength && Array.from(text).length > settings.maxTextLength) {
    return fail(
      400,
      "INVALID_REQUEST",
      `text exceeds sendMaxTextLength (${settings.maxTextLength})`,
    );
  }

  // ── Chunk ───────────────────────────────────────────────────────────────
  // SDK helpers are optional (see loadSdkChunking): without them we still chunk
  // via the plugin's own `chunker` or OCG's built-in splitter.
  const sdk = await (deps.loadSdkChunking ?? loadSdkChunking)();
  const chunkerMode = resolveAdapterChunkMode(outbound);
  let softMode: ChunkMode = "length";
  if (sdk) {
    try {
      softMode = sdk.resolveChunkMode(cfg, channel, accountId);
    } catch {
      softMode = "length";
    }
  }

  let limit = resolveChunkLimit(outbound, cfg, channel, accountId, sdk);
  let chunks = splitIntoChunks(outbound, text, limit, chunkerMode, softMode, sdk);

  if (settings.chunkPrefix && chunks.length > 0) {
    // Re-chunk with the prefix width reserved so the final payload stays within
    // the channel limit (mirrors the reply path's two-pass approach).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reserved = Math.max(1, limit - CHUNK_PREFIX_RESERVE);
      const next = splitIntoChunks(outbound, text, reserved, chunkerMode, softMode, sdk);
      if (next.length === chunks.length) break;
      chunks = next;
    }
    chunks = withChunkPrefix(chunks);
  }

  const totalChunks = Math.max(chunks.length, media ? 1 : 0);

  // ── Send ────────────────────────────────────────────────────────────────
  const results: Array<{ ok: boolean; messageId?: string; receipt?: unknown; error?: string }> = [];

  const work = async (): Promise<void> => {
    let first = true;
    if (media) {
      const caption = chunks[0] ?? "";
      first = false;
      try {
        const result = await outbound.sendMedia!({
          cfg,
          channel,
          to: target.to,
          text: caption,
          mediaUrl: media,
          accountId,
          replyToId: replyToId ?? undefined,
        });
        const error = extractSendError(result);
        results.push({
          ok: !error,
          messageId: typeof result?.messageId === "string" && result.messageId !== ""
            ? result.messageId
            : undefined,
          receipt: result?.receipt,
          error,
        });
      } catch (err) {
        results.push({ ok: false, error: (err as Error).message });
      }
    }

    for (let index = media ? 1 : 0; index < chunks.length; index += 1) {
      const useReplyTo = first ? replyToId ?? undefined : undefined;
      first = false;
      try {
        const result = await outbound.sendText!({
          cfg,
          channel,
          to: target.to,
          text: chunks[index],
          accountId,
          replyToId: useReplyTo,
        });
        const error = extractSendError(result);
        results.push({
          ok: !error,
          messageId: typeof result?.messageId === "string" && result.messageId !== ""
            ? result.messageId
            : undefined,
          receipt: result?.receipt,
          error,
        });
      } catch (err) {
        results.push({ ok: false, error: (err as Error).message });
      }
    }
  };

  // Timeout covers the platform send phase only: lazy plugin loading (first use
  // in a fresh process) happens above and is not charged against sendTimeoutMs.
  const chunked = await withTimeout(work(), settings.timeoutMs);

  if (chunked.timedOut) {
    const elapsedMs = now() - startedAt;
    const chunksSent = results.filter((result) => result.ok).length;
    log({
      ...baseLog,
      ok: false,
      errorCode: "PLATFORM_SEND_FAILED",
      reason: "timeout",
      uncertain: true,
      chunks: totalChunks,
      chunksSent,
      elapsedMs,
    });
    return {
      httpStatus: 502,
      body: {
        ok: false,
        code: "PLATFORM_SEND_FAILED",
        reason: "timeout",
        uncertain: true,
        message:
          `send timed out after ${settings.timeoutMs}ms; platform delivery state unknown`,
        partial: chunksSent > 0,
        chunksSent,
        chunksTotal: totalChunks,
        elapsedMs,
      },
    };
  }

  const sent = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  const messageId = [...results].reverse().find((result) => result.messageId)?.messageId ?? null;
  const receipt = [...results].reverse().find((result) => result.receipt)?.receipt ?? null;
  const elapsedMs = now() - startedAt;
  const partial = sent > 0 && failed.length > 0;

  if (failed.length > 0) {
    const firstError = failed[0].error ?? "platform rejected the message";
    const platformCode = extractPlatformCode(firstError);
    log({
      ...baseLog,
      ok: false,
      errorCode: "PLATFORM_SEND_FAILED",
      chunks: totalChunks,
      chunksSent: sent,
      messageId,
      degraded,
      targetValidated: target.validated,
      elapsedMs,
    });
    return {
      httpStatus: 502,
      body: {
        ok: false,
        code: "PLATFORM_SEND_FAILED",
        message: firstError,
        ...(platformCode ? { platformCode } : {}),
        partial,
        chunksSent: sent,
        chunksTotal: totalChunks,
        ...(partial ? { messageId } : {}),
        ...(degraded ? { degraded } : {}),
        elapsedMs,
      },
    };
  }

  log({
    ...baseLog,
    ok: true,
    chunks: totalChunks,
    chunksSent: sent,
    chunksTotal: totalChunks,
    messageId,
    degraded,
    targetValidated: target.validated,
    elapsedMs,
  });

  return {
    httpStatus: 200,
    body: {
      ok: true,
      channel,
      to: maskTarget(target.to),
      chunks: totalChunks,
      chunksSent: sent,
      chunksTotal: totalChunks,
      messageId,
      ...(receipt ? { receipt } : {}),
      degraded,
      targetValidated: target.validated,
      elapsedMs,
    },
  };
}
