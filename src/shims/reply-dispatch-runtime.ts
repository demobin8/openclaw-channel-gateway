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

  // Resolve agent API URL from config or env
  const liteGw = (cfg.liteGateway ?? {}) as Record<string, unknown>;
  const agentUrl =
    (liteGw.agentUrl as string) ||
    process.env.LITE_GATEWAY_AGENT_URL ||
    "http://127.0.0.1:11434/v1/chat/completions";

  const model =
    (liteGw.model as string) ||
    (cfg.agents &&
    typeof cfg.agents === "object" &&
    (cfg.agents as Record<string, unknown>).defaults &&
    typeof (cfg.agents as Record<string, unknown>).defaults === "object"
      ? ((cfg.agents as Record<string, unknown>).defaults as Record<string, unknown>).model
      : undefined) ||
    process.env.LITE_GATEWAY_MODEL ||
    "gpt-4o";

  // Some configs store model as a string, others as an object { primary: "..." }
  const modelStr =
    typeof model === "string"
      ? model
      : typeof model === "object" && model && typeof (model as Record<string, unknown>).primary === "string"
        ? (model as Record<string, string>).primary
        : process.env.LITE_GATEWAY_MODEL || "gpt-4o";

  const apiKey = process.env.LITE_GATEWAY_API_KEY || "";

  console.log(`[lite-gateway] Dispatching from ${from} to ${modelStr} via ${agentUrl}`);

  const { deliver, beforeDeliver, onModelSelected } = dispatcherOptions;

  // Signal model selection (triggers typing indicator, etc.)
  try {
    await onModelSelected?.(modelStr);
  } catch {
    // Not critical
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

    // Stream SSE response
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let blockIndex = 0;
    let finalDelivered = false;
    const deliveredCounts: Record<string, number> = { block: 0, final: 0, tool: 0 };

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

          const payload = { text: content, isError: false };

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
            await deliver(finalPayload, {
              kind: "block",
              assistantMessageIndex: blockIndex,
            });
            deliveredCounts.block++;
          }
          blockIndex++;
        } catch {
          // Skip unparseable SSE lines
        }
      }
    }

    // Deliver final payload
    const finalPayload = { text: fullText, isError: false };

    let finalToDeliver = finalPayload;
    if (beforeDeliver) {
      const result = await beforeDeliver(finalPayload, {
        kind: "final",
        assistantMessageIndex: blockIndex,
      });
      if (result) finalToDeliver = result as typeof finalToDeliver;
    }

    if (deliver && finalToDeliver) {
      await deliver(finalToDeliver, {
        kind: "final",
        assistantMessageIndex: blockIndex,
      });
      deliveredCounts.final++;
      finalDelivered = true;
    }

    console.log(
      `[lite-gateway] Dispatch complete: ${fullText.length} chars, ${deliveredCounts.block} blocks`,
    );

    return { queuedFinal: finalDelivered, counts: deliveredCounts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[lite-gateway] Agent dispatch error: ${message}`);

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
