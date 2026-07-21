/**
 * Lite gateway shim for `openclaw/plugin-sdk/reply-dispatch-runtime`.
 *
 * Re-exports real utility functions from the openclaw package while
 * replacing `dispatchReplyWithBufferedBlockDispatcher` and
 * `dispatchReplyWithDispatcher` with an HTTP forward to an external
 * OpenAI-compatible agent API.
 */

// Re-export utility functions from the real openclaw package (loader
// skips interception when the caller is our own shim file).
export {
  resolveChunkMode,
  generateConversationLabel,
  finalizeInboundContext,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";

// Re-export types that the real module provides
export type {
  CommandTurnContext,
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
  ReplyPayload,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";

import { deliverPayloadInChunks, resolveReplyChunkSize, rewriteLocalMediaPathsForDelivery } from "../reply-chunking.js";
import { resolveChannelAcpConfig, resolveChannelAgentType, resolveChannelAgentUrl, resolveChannelIdFromContext } from "../config.js";
import { buildAcpConfigFromEnv, getAcpAgent } from "../acp-agent.js";

// ── HTTP dispatch implementation ────────────────────────────────────────

async function httpDispatch({
  ctx,
  cfg,
  dispatcherOptions,
}: {
  ctx: Record<string, unknown>;
  cfg: Record<string, unknown>;
  dispatcherOptions: {
    deliver?: (payload: Record<string, unknown>, meta: Record<string, unknown>) => Promise<void>;
    beforeDeliver?: (
      payload: Record<string, unknown>,
      meta: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | null>;
    onModelSelected?: (model: string) => Promise<void>;
  };
}): Promise<Record<string, unknown>> {
  const body =
    (typeof ctx.BodyForAgent === "string" && ctx.BodyForAgent) ||
    (typeof ctx.Body === "string" && ctx.Body) ||
    (typeof ctx.CommandBody === "string" && ctx.CommandBody) ||
    (typeof ctx.RawBody === "string" && ctx.RawBody) ||
    "";

  const from = String(ctx.From ?? "unknown");
  const sessionKey = String(ctx.SessionKey ?? "default");

  // Resolve channel id from explicit context fields first, then SessionKey/From.
  const channelId = resolveChannelIdFromContext(ctx) || sessionKey.split(":")[0] || undefined;
  const agentUser = channelId && !sessionKey.startsWith(`${channelId}:`)
    ? `${channelId}:${sessionKey}`
    : sessionKey;

  /** Rewrite local file paths in reply text so QQ Bot plugin can access them. */
  const maybeRewriteMedia = (text: string) =>
    channelId === "qqbot" ? rewriteLocalMediaPathsForDelivery(text) : text;

  const agentType = resolveChannelAgentType(channelId, cfg);

  // Resolve agent API URL — per-channel override first, then global fallback
  const agentUrl = agentType === "http" ? resolveChannelAgentUrl(channelId, cfg) : "acp://stdio";

  const liteGw = (cfg.liteGateway ?? {}) as Record<string, unknown>;
  const model =
    (liteGw.model as string) ||
    (cfg.agents &&
    typeof cfg.agents === "object" &&
    (cfg.agents as Record<string, unknown>).defaults &&
    typeof (cfg.agents as Record<string, unknown>).defaults === "object"
      ? ((cfg.agents as Record<string, unknown>).defaults as Record<string, unknown>).model
      : undefined) ||
    process.env.OCG_MODEL ||
    "gpt-4o";

  // Some configs store model as a string, others as an object { primary: "..." }
  const modelStr =
    typeof model === "string"
      ? model
      : typeof model === "object" && model && typeof (model as Record<string, unknown>).primary === "string"
        ? (model as Record<string, string>).primary
        : process.env.OCG_MODEL || "gpt-4o";

  const apiKey = process.env.OCG_API_KEY || "";

  const verbose =
    (liteGw.verbose as boolean) ||
    process.env.OCG_VERBOSE === "1";
  const replyChunkSize = resolveReplyChunkSize(liteGw.replyChunkSize);

  // ── Verbose: log incoming message ────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📥 [IN]  From: ${from}  |  Session: ${sessionKey}`);
  if (verbose) {
    console.log(`       Body (${body.length} chars):`);
    const preview = body.length > 2000 ? body.slice(0, 2000) + "\n... (truncated)" : body;
    console.log(preview.split("\n").map((l) => `       │ ${l}`).join("\n"));
  } else {
    const oneLiner = body.replace(/\n/g, "\\n");
    const preview =
      oneLiner.length > 200 ? oneLiner.slice(0, 200) + "..." : oneLiner;
    console.log(`       Body: ${preview}`);
  }
  console.log(`       → ${modelStr} @ ${agentUrl}`);

  const { deliver, beforeDeliver, onModelSelected } = dispatcherOptions;

  // Signal model selection (triggers typing indicator, etc.)
  try {
    await onModelSelected?.(modelStr);
  } catch {
    // Not critical
  }

  // ── ACP stdio mode ─────────────────────────────────────────────────
  if (agentType === "acp") {
    const acpCfg = {
      ...buildAcpConfigFromEnv(),
      ...resolveChannelAcpConfig(channelId, cfg),
      model: modelStr,
    };
    const agent = getAcpAgent(acpCfg);
    let fullText = "";
    let blockIndex = 0;
    const deliveredCounts: Record<string, number> = { block: 0, final: 0, tool: 0 };

    try {
      const streamBlocks = liteGw.acpStreamBlocks === true || ctx.AcpStreamBlocks === true;
      fullText = await agent.chat(sessionKey, body, {
        onDelta: async (text) => {
          if (!streamBlocks || !text) return;
          const payload = { text: maybeRewriteMedia(text), isError: false };
          let finalPayload = payload;
          if (beforeDeliver) {
            const result = await beforeDeliver(payload, {
              kind: "block",
              assistantMessageIndex: blockIndex,
            });
            if (result === null) return;
            if (result) finalPayload = result as typeof finalPayload;
          }
          if (deliver) {
            deliveredCounts.block += await deliverPayloadInChunks(deliver, finalPayload, {
              kind: "block",
              assistantMessageIndex: blockIndex,
            }, replyChunkSize);
          }
          blockIndex++;
        },
      });

      const finalPayload = { text: maybeRewriteMedia(fullText), isError: false };
      let finalToDeliver = finalPayload;
      if (beforeDeliver) {
        const result = await beforeDeliver(finalPayload, {
          kind: "final",
          assistantMessageIndex: blockIndex,
        });
        if (result) finalToDeliver = result as typeof finalToDeliver;
      }
      if (deliver && finalToDeliver) {
        deliveredCounts.final += await deliverPayloadInChunks(deliver, finalToDeliver, {
          kind: "final",
          assistantMessageIndex: blockIndex,
        }, replyChunkSize);
      }

      console.log(`📤 [OUT:ACP] ${fullText.length} chars, ${deliveredCounts.block} blocks`);
      console.log(`${"=".repeat(60)}\n`);
      return { queuedFinal: true, counts: deliveredCounts, acp: agent.info() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ocg] ACP dispatch error: ${message}`);
      if (deliver) {
        await deliver({ text: `ACP agent error: ${message}`, isError: true }, {
          kind: "final",
          assistantMessageIndex: 0,
        }).catch(() => undefined);
      }
      return {
        queuedFinal: false,
        counts: { block: 0, final: 1, tool: 0 },
        failedCounts: { final: 1 },
      };
    }
  }

  // ── Async (fire & forget) mode ──────────────────────────────────────
  const isAsync = Boolean(liteGw.async);
  if (isAsync && deliver) {
    const { registerDeliver, buildCallbackUrl, getCallbackPort } =
      await import("../callback-server.js");

    const ttlMs = ((liteGw.callbackTokenTTL as number) ?? 1800) * 1000;
    const callbackToken = registerDeliver(deliver, ttlMs);
    const callbackHost = (liteGw.callbackPublicHost as string) ?? (liteGw.callbackHost as string) ?? "0.0.0.0";
    const callbackPort = (liteGw.callbackPublicPort as number) ?? (getCallbackPort() || (liteGw.callbackPort as number) || 3457);
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
    // Request body stays OpenAI-compatible; user carries the stable IM session key.
    fetch(agentUrl, {
      method: "POST",
      headers: asyncHeaders,
      body: JSON.stringify({
        model: modelStr,
        messages: [{ role: "user", content: body }],
        stream: false,
        user: agentUser,
      }),
      signal: AbortSignal.timeout(300_000),
    }).catch((err: Error) => {
      console.error(`[ocg] Async forward error: ${err.message}`);
    });

    return { queuedFinal: false, async: true, callbackToken };
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
        user: agentUser,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Agent API returned ${response.status}: ${errText.slice(0, 200)}`);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    let fullText = "";
    let blockIndex = 0;
    let finalDelivered = false;
    const deliveredCounts: Record<string, number> = { block: 0, final: 0, tool: 0 };

    if (contentType.includes("text/event-stream")) {
      // ── SSE stream ──────────────────────────────────────────────────
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (!content) continue;

            fullText += content;

            const payload = { text: maybeRewriteMedia(content), isError: false };

            let finalPayload = payload;
            if (beforeDeliver) {
              const result = await beforeDeliver(payload, {
                kind: "block",
                assistantMessageIndex: blockIndex,
              });
              if (result === null) continue;
              if (result) finalPayload = result as typeof finalPayload;
            }

            if (deliver) {
              deliveredCounts.block += await deliverPayloadInChunks(deliver, finalPayload, {
                kind: "block",
                assistantMessageIndex: blockIndex,
              }, replyChunkSize);
            }
            blockIndex++;
          } catch {
            // Skip unparseable SSE lines
          }
        }
      }
    } else {
      // ── Non-streaming JSON ──────────────────────────────────────────
      const raw = await response.text();
      if (verbose) {
        console.log(`[ocg] Non-streaming response (${raw.length} chars): ${raw.slice(0, 500)}`);
      }

      try {
        const parsed = JSON.parse(raw);
        // Extract content from various JSON paths
        let content =
          parsed?.choices?.[0]?.message?.content ??
          parsed?.choices?.[0]?.text ??
          parsed?.content ??
          parsed?.response ??
          parsed?.output ??
          raw;

        if (typeof content !== "string") {
          content = JSON.stringify(content);
        }

        fullText = content;

        // Deliver as final (non-streaming has no blocks)
        const finalPayload = { text: maybeRewriteMedia(fullText), isError: false };

        let finalToDeliver = finalPayload;
        if (beforeDeliver) {
          const result = await beforeDeliver(finalPayload, {
            kind: "final",
            assistantMessageIndex: 0,
          });
          if (result) finalToDeliver = result as typeof finalToDeliver;
        }

        if (deliver && finalToDeliver) {
          deliveredCounts.final += await deliverPayloadInChunks(deliver, finalToDeliver, {
            kind: "final",
            assistantMessageIndex: 0,
          }, replyChunkSize);
          finalDelivered = true;
        }
      } catch {
        // Not valid JSON → treat as plain text
        fullText = raw;
        const finalPayload = { text: maybeRewriteMedia(fullText), isError: false };
        if (deliver) {
          deliveredCounts.final += await deliverPayloadInChunks(deliver, finalPayload, {
            kind: "final",
            assistantMessageIndex: 0,
          }, replyChunkSize);
          finalDelivered = true;
        }
      }
    }

    // Deliver final payload (only if not already delivered in non-streaming path)
    if (!finalDelivered) {
      const finalPayload = { text: maybeRewriteMedia(fullText), isError: false };

      let finalToDeliver = finalPayload;
      if (beforeDeliver) {
        const result = await beforeDeliver(finalPayload, {
          kind: "final",
          assistantMessageIndex: blockIndex,
        });
        if (result) finalToDeliver = result as typeof finalToDeliver;
      }

      if (deliver && finalToDeliver) {
        deliveredCounts.final += await deliverPayloadInChunks(deliver, finalToDeliver, {
          kind: "final",
          assistantMessageIndex: blockIndex,
        }, replyChunkSize);
        finalDelivered = true;
      }
    }

    // ── Verbose: log outgoing response ─────────────────────────────────
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
    if (deliver) {
      try {
        await deliver(
          { text: `\u26a0\ufe0f Agent error: ${message}`, isError: true },
          { kind: "final", assistantMessageIndex: 0 },
        );
      } catch {
        // Best effort
      }
    }

    return {
      queuedFinal: false,
      counts: { block: 0, final: 1, tool: 0 },
      failedCounts: { final: 1 },
    };
  }
}

/**
 * The main dispatch function called by all channel plugins.
 * Replaces the full OpenClaw agent engine with an HTTP forward.
 */
export const dispatchReplyWithBufferedBlockDispatcher: (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>> = async (params) => {
  return httpDispatch(params as Parameters<typeof httpDispatch>[0]);
};

/**
 * Alternative dispatch entry point (used by Discord native commands).
 * Same HTTP forward behavior.
 */
export const dispatchReplyWithDispatcher: (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>> = async (params) => {
  return httpDispatch(params as Parameters<typeof httpDispatch>[0]);
};
