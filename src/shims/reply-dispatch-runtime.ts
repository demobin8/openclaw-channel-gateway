/**
 * Lite gateway shim for `openclaw/plugin-sdk/reply-dispatch-runtime`.
 *
 * Re-exports real utility functions from the openclaw package while
 * replacing `dispatchReplyWithBufferedBlockDispatcher` and
 * `dispatchReplyWithDispatcher` with the shared inbound dispatch
 * (`src/inbound.ts`), which forwards to an HTTP/ACP agent or enqueues the
 * message in the mailbox transport.
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

import { dispatchInbound } from "../inbound.js";

type BufferedDispatchParams = {
  ctx?: Record<string, unknown>;
  cfg?: Record<string, unknown>;
  dispatcherOptions?: {
    deliver?: (payload: Record<string, unknown>, meta: Record<string, unknown>) => Promise<void>;
    beforeDeliver?: (
      payload: Record<string, unknown>,
      meta: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | null>;
    onModelSelected?: (model: string) => Promise<void>;
  };
};

/**
 * The main dispatch function called by all channel plugins.
 * Replaces the full OpenClaw agent engine with the configured transport.
 *
 * `replyOptions` is intentionally not forwarded here: this entry historically
 * ignored it (only the from-config entry honours `disableBlockStreaming`), and
 * keeping that exact behaviour matters for existing channels (see techdesign
 * §5.2 and the review notes on the two entries' delivery semantics).
 */
async function bufferedDispatch(params: BufferedDispatchParams): Promise<Record<string, unknown>> {
  const dispatcherOptions = params.dispatcherOptions ?? {};
  return await dispatchInbound({
    ctx: params.ctx ?? {},
    cfg: params.cfg ?? {},
    ...(dispatcherOptions.deliver ? { deliver: dispatcherOptions.deliver } : {}),
    ...(dispatcherOptions.beforeDeliver ? { beforeDeliver: dispatcherOptions.beforeDeliver } : {}),
    ...(dispatcherOptions.onModelSelected ? { onModelSelected: dispatcherOptions.onModelSelected } : {}),
    finalPolicy: "always",
  });
}

export const dispatchReplyWithBufferedBlockDispatcher: (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>> = async (params) => {
  return bufferedDispatch(params as BufferedDispatchParams);
};

/**
 * Alternative dispatch entry point (used by Discord native commands).
 * Same behavior.
 */
export const dispatchReplyWithDispatcher: (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>> = async (params) => {
  return bufferedDispatch(params as BufferedDispatchParams);
};
