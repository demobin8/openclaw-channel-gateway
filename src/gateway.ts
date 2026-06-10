/**
 * Lite Gateway — Channel lifecycle (delegates to dynamic plugin loader).
 */

import type { LiteGatewayChannelConfig } from "./config.js";
import {
  loadAllPlugins,
  startChannel as loadStartChannel,
  stopChannel as loadStopChannel,
  stopAllChannels,
  listRunningChannels as loadListRunning,
  isChannelRunning,
} from "./plugin-loader.js";

// ── Public API ────────────────────────────────────────────────────────────

export async function ensurePluginsLoaded(): Promise<void> {
  await loadAllPlugins();
}

export async function startChannel(
  channelId: string,
  config: LiteGatewayChannelConfig,
): Promise<void> {
  // Resolve token: config > env var (per-channel or legacy telegram)
  const envKey = `LITE_GATEWAY_${channelId.toUpperCase()}_TOKEN`;
  const token =
    config.token ||
    process.env[envKey] ||
    (channelId === "telegram" ? process.env.LITE_GATEWAY_TELEGRAM_TOKEN : undefined) ||
    "";

  // Pass all config fields through (appId, clientSecret, etc.)
  const extraCfg: Record<string, unknown> = { ...config };
  delete (extraCfg as Record<string, unknown>)["enabled"];
  if (token) extraCfg.token = token;

  await loadStartChannel(channelId, token || "", extraCfg);
}

export async function stopChannel(channelId: string): Promise<void> {
  await loadStopChannel(channelId);
}

export async function restartChannel(
  channelId: string,
  config: LiteGatewayChannelConfig,
): Promise<void> {
  await stopChannel(channelId);
  await startChannel(channelId, config);
}

export function getChannelStatus(channelId: string) {
  return isChannelRunning(channelId)
    ? { channelId, status: "running" as const, startedAt: 0 }
    : null;
}

export function listRunningChannels() {
  return loadListRunning().map((id) => ({
    channelId: id,
    status: "running" as const,
    startedAt: 0,
    error: undefined as string | undefined,
    stop: async () => { await loadStopChannel(id); },
  }));
}

export async function startAll(
  channels: Record<string, LiteGatewayChannelConfig>,
): Promise<Array<{ channelId: string; status: string; startedAt: number }>> {
  await ensurePluginsLoaded();

  const results: Array<{ channelId: string; status: string; startedAt: number }> = [];
  for (const [id, cfg] of Object.entries(channels)) {
    if (cfg.enabled === false) continue;
    try {
      await startChannel(id, cfg);
      results.push({ channelId: id, status: "running", startedAt: Date.now() });
    } catch (err) {
      console.error(`[lite-gateway] Failed to start ${id}:`, (err as Error).message);
    }
  }
  return results;
}

export { stopAllChannels as stopAll };
