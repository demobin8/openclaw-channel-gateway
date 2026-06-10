/**
 * Lite Gateway — main module.
 *
 * A minimal OpenClaw channel gateway that bridges IM channels to any
 * OpenAI-compatible agent API via HTTP.
 */

import { loadConfig, resolveConfigPath, type LiteGatewayConfig } from "./config.js";
import { startAll, stopAll, listRunningChannels } from "./gateway.js";

export {
  loadConfig, resolveConfigPath, saveConfig, addChannel, removeChannel,
  listConfiguredChannels, listAllChannels,
} from "./config.js";
export type { LiteGatewayConfig, LiteGatewayChannelConfig } from "./config.js";
export { startChannel, stopChannel, restartChannel, getChannelStatus, startAll, stopAll } from "./gateway.js";

function applyEnv(cfg: LiteGatewayConfig): void {
  if (cfg.verbose) process.env.LITE_GATEWAY_VERBOSE = "1";
  if (cfg.agentUrl) process.env.LITE_GATEWAY_AGENT_URL = cfg.agentUrl;
  if (cfg.model) process.env.LITE_GATEWAY_MODEL = cfg.model;
  if (cfg.apiKey) process.env.LITE_GATEWAY_API_KEY = cfg.apiKey;
}

export async function startGateway(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) throw new Error("No config found. Create lite-gateway.json");

  applyEnv(cfg);

  const channels = cfg.channels ?? {};
  const enabled = Object.entries(channels).filter(([, c]) => c?.enabled !== false);
  if (enabled.length === 0) throw new Error("No channels enabled");

  const results = await startAll(channels);
  console.log(`[lite-gateway] ${results.length} channel(s) running`);
}

export async function stopGateway(): Promise<void> {
  await stopAll();
}

export function gatewayStatus(): Record<string, unknown> {
  const running = listRunningChannels();
  const cfg = loadConfig();
  const configured = cfg?.channels ? Object.keys(cfg.channels) : [];

  return {
    configured: configured.length,
    running: running.length,
    channels: running.map((b) => ({
      id: b.channelId,
      status: b.status,
      uptime: b.startedAt ? Math.round((Date.now() - b.startedAt) / 1000) : 0,
      error: b.error,
    })),
    agentUrl: cfg?.agentUrl || process.env.LITE_GATEWAY_AGENT_URL || "(not set)",
    model: cfg?.model || process.env.LITE_GATEWAY_MODEL || "(not set)",
  };
}
