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
import path from "node:path";
import os from "node:os";
import type { DeliverFn } from "../callback-server.js";

// ── Imports from real OpenClaw plugin-sdk (loader bypasses interception for shim callers) ──

import {
  shouldComputeCommandAuthorized,
  resolveCommandAuthorizedFromAuthorizers,
  isControlCommandMessage,
} from "openclaw/plugin-sdk/command-auth";

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

import {
  saveMediaBuffer as ocgSaveMediaBuffer,
} from "openclaw/plugin-sdk/media-store";

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

// ── HTTP-forward dispatchReplyFromConfig ─────────────────────────────────

/**
 * Our replacement for the OpenClaw agent pipeline.
 *
 * When the WeChat plugin receives a message, `processOneMessage` does auth,
 * routing, session setup, then calls:
 *
 *   channelRuntime.reply.dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions })
 *
 * We intercept that call here: extract the user message, send to the
 * configured HTTP agent endpoint, receive the response, and deliver it
 * back through the dispatcher (which sends it via WeChat).
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

  const from = String(ctx.From ?? "unknown");
  const sessionKey = String(ctx.SessionKey ?? "default");

  // Resolve agent API URL from config or env
  const liteGw = (cfg.liteGateway ?? {}) as Record<string, unknown>;
  const agentUrl =
    (liteGw.agentUrl as string) ||
    process.env.OCG_AGENT_URL ||
    "http://127.0.0.1:11434/v1/chat/completions";

  const modelRaw =
    (liteGw.model as string | Record<string, unknown>) ||
    (cfg.agents &&
    typeof cfg.agents === "object" &&
    (cfg.agents as Record<string, unknown>).defaults &&
    typeof (cfg.agents as Record<string, unknown>).defaults === "object"
      ? ((cfg.agents as Record<string, unknown>).defaults as Record<string, unknown>).model
      : undefined) ||
    process.env.OCG_MODEL ||
    "gpt-4o";

  const modelStr =
    typeof modelRaw === "string"
      ? modelRaw
      : typeof modelRaw === "object" && modelRaw && typeof (modelRaw as Record<string, unknown>).primary === "string"
        ? (modelRaw as Record<string, string>).primary
        : process.env.OCG_MODEL || "gpt-4o";

  const apiKey = (process.env.OCG_API_KEY as string) || "";

  const verbose =
    (liteGw.verbose as boolean) ||
    process.env.OCG_VERBOSE === "1";

  // ── Log incoming message ──────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📥 [IN]  From: ${from}  |  Session: ${sessionKey}`);
  if (verbose) {
    console.log(`       Body (${body.length} chars):`);
    const preview = body.length > 2000 ? body.slice(0, 2000) + "\n... (truncated)" : body;
    console.log(preview.split("\n").map((l: string) => `       │ ${l}`).join("\n"));
  } else {
    const oneLiner = body.replace(/\n/g, "\\n");
    const preview =
      oneLiner.length > 200 ? oneLiner.slice(0, 200) + "..." : oneLiner;
    console.log(`       Body: ${preview}`);
  }
  console.log(`       → ${modelStr} @ ${agentUrl}`);

  // ── Async (fire & forget) mode ──────────────────────────────────────
  const isAsync = Boolean(liteGw.async);
  if (isAsync) {
    const { registerDeliver, buildCallbackUrl, getCallbackPort } =
      await import("../callback-server.js");

    // Wrap dispatcher methods into a single deliver function
    const deliver: DeliverFn = async (payload, meta) => {
      if (meta.kind === "block") {
        dispatcher.sendBlockReply(payload);
      } else {
        dispatcher.sendFinalReply(payload);
      }
    };

    const callbackToken = registerDeliver(deliver);
    const callbackHost = (liteGw.callbackHost as string) ?? "127.0.0.1";
    const callbackPort = getCallbackPort() || (liteGw.callbackPort as number) || 3457;
    const callbackUrl = buildCallbackUrl(callbackHost, callbackPort, callbackToken);

    console.log(`[ocg] Async dispatch → agent, callback=${callbackUrl}`);

    const asyncHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "X-OCG-Callback": callbackUrl,
    };
    if (apiKey) {
      asyncHeaders["Authorization"] = `Bearer ${apiKey}`;
    }

    // Fire & forget — do NOT await
    fetch(agentUrl, {
      method: "POST",
      headers: asyncHeaders,
      body: JSON.stringify({
        model: modelStr,
        messages: [{ role: "user", content: body }],
        stream: false,
      }),
      signal: AbortSignal.timeout(300_000),
    }).catch((err: Error) => {
      console.error(`[ocg] Async forward error: ${err.message}`);
    });

    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(agentUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelStr,
        messages: [{ role: "user", content: body }],
        stream: true,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Agent API returned ${response.status}: ${errText.slice(0, 200)}`);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const disableBlockStreaming = params.replyOptions?.disableBlockStreaming === true;
    let fullText = "";
    let finalDelivered = false;
    const deliveredCounts: Record<string, number> = { block: 0, final: 0, tool: 0 };

    // Helper: queue content — when block streaming is disabled, skip blocks
    const queueBlock = (text: string) => {
      if (disableBlockStreaming) return;
      dispatcher.sendBlockReply({ text, isError: false });
      deliveredCounts.block++;
    };

    // ── Case 1: SSE streaming (text/event-stream) ─────────────────────────
    if (contentType.includes("text/event-stream")) {
      console.log(`[ocg] SSE stream detected, reading chunks...`);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        // Log raw chunk for debugging
        if (verbose || fullText.length === 0) {
          console.log(`[ocg] SSE raw chunk (${chunk.length} bytes):\n${chunk.slice(0, 500)}`);
        }

        const lines = chunk.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            // OpenAI format: choices[0].delta.content
            const content =
              parsed.choices?.[0]?.delta?.content ??
              parsed.choices?.[0]?.message?.content ??
              parsed.content ??
              parsed.text ??
              "";
            if (!content) continue;

            if (verbose) console.log(`[ocg] SSE delta: "${content}"`);
            fullText += content;
            queueBlock(content);
          } catch (parseErr) {
            console.warn(`[ocg] SSE parse error: ${(parseErr as Error).message} — data: ${data.slice(0, 100)}`);
          }
        }
      }
    } else {
      // ── Case 2: Non-streaming JSON (plain application/json) ─────────────
      console.log(`[ocg] Non-streaming response (content-type: ${contentType || "none"}), reading body...`);
      const rawText = await response.text();
      console.log(`[ocg] Raw response (${rawText.length} bytes):\n${rawText.slice(0, 1500)}`);

      try {
        const parsed = JSON.parse(rawText);
        // Try multiple possible response shapes
        const content =
          parsed.choices?.[0]?.message?.content ??
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.text ??
          parsed.content ??
          parsed.text ??
          parsed.response ??
          parsed.message ??
          "";

        if (typeof content === "string" && content.trim()) {
          fullText = content;
          // Non-streaming: only final reply, no block (avoids duplicate)
        }
      } catch (parseErr) {
        // Treat raw text as response
        console.warn(`[ocg] JSON parse failed: ${(parseErr as Error).message}, treating as raw text`);
        if (rawText.trim()) {
          fullText = rawText;
        }
      }
    }

    // Send final payload (skip if blocks already delivered the content incrementally)
    if (fullText && deliveredCounts.block === 0) {
      dispatcher.sendFinalReply({ text: fullText, isError: false });
      deliveredCounts.final++;
      finalDelivered = true;
    } else {
      console.warn(`[ocg] No text extracted from response`);
    }

    // ── Log outgoing response ───────────────────────────────────────────
    console.log(`📤 [OUT] ${fullText.length} chars, ${deliveredCounts.block} blocks`);
    if (verbose) {
      const lines = fullText.split("\n");
      for (const line of lines) {
        console.log(`       │ ${line}`);
      }
    } else {
      const oneLiner = fullText.replace(/\n/g, "\\n");
      const preview =
        oneLiner.length > 300 ? oneLiner.slice(0, 300) + "..." : oneLiner;
      console.log(`       Text: ${preview}`);
    }
    console.log(`${"=".repeat(60)}\n`);

    return { queuedFinal: finalDelivered, counts: deliveredCounts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ocg] Agent dispatch error: ${message}`);

    // Deliver error to the user
    try {
      dispatcher.sendFinalReply({
        text: `\u26a0\ufe0f Agent error: ${message}`,
        isError: true,
      });
    } catch {
      // Best effort
    }

    return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
  }
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

// ── saveMediaBuffer (fallback) ───────────────────────────────────────────

async function saveMediaBuffer(buffer: Buffer, opts: Record<string, unknown>): Promise<string> {
  try {
    const key = (opts.key as string) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return (await ocgSaveMediaBuffer(buffer, key as string)) as unknown as string;
  } catch {
    const dir = (opts.dir as string) || path.resolve(os.tmpdir(), "ocg-media");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    const fpath = path.resolve(dir, fname);
    await fs.writeFile(fpath, buffer);
    return fpath;
  }
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

        console.log(`[ocg] inbound.run: message from adapter, id=${input.id}, textForAgent=${String(input.textForAgent ?? "").slice(0, 60)}`);

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
