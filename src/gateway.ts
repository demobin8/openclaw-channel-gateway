/**
 * Lite Gateway — Channel lifecycle (delegates to dynamic plugin loader).
 */

import { loadConfig, buildOpenClawConfig, applyConfigEnvOverrides, type LiteGatewayConfig } from "./config.js";
import {
  loadAllPlugins,
  startChannel as loadStartChannel,
  stopChannel as loadStopChannel,
  stopAllChannels,
  listRunningChannels as loadListRunning,
  isChannelRunning,
  listRunningAccounts,
} from "./plugin-loader.js";
import { startCallbackServer, stopCallbackServer, isCallbackServerRunning } from "./callback-server.js";

// ── Public API ────────────────────────────────────────────────────────────

export async function ensurePluginsLoaded(): Promise<void> {
  await loadAllPlugins();
}

/**
 * Start a single channel using its plugin's config adapter.
 * The full config (OpenClaw format) is passed through.
 */
export async function startChannel(
  channelId: string,
  cfg: Record<string, unknown>,
): Promise<string[]> {
  return await loadStartChannel(channelId, cfg);
}

export async function stopChannel(channelId: string): Promise<void> {
  await loadStopChannel(channelId);
}

export async function restartChannel(
  channelId: string,
  cfg: Record<string, unknown>,
): Promise<string[]> {
  await stopChannel(channelId);
  return await startChannel(channelId, cfg);
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
    stop: async () => {
      await loadStopChannel(id);
    },
  }));
}

export { listRunningAccounts, stopAllChannels as stopAll };

/**
 * Start all enabled channels from config.
 * Each channel's plugin config adapter determines which accounts are enabled.
 */
export async function startAll(
  rawCfg: LiteGatewayConfig,
): Promise<
  Array<{ channelId: string; accountId: string; status: string; startedAt: number }>
> {
  await ensurePluginsLoaded();

  applyConfigEnvOverrides(rawCfg);

  // Start callback server for async dispatch (only if not already running)
  if (!isCallbackServerRunning()) {
    const cbHost = rawCfg.callbackHost ?? "127.0.0.1";
    const cbPort = rawCfg.callbackPort ?? 3457;
    try {
      await startCallbackServer(cbHost, cbPort, rawCfg.callbackSecret);
    } catch (err) {
      console.error(`[ocg] Failed to start callback server: ${(err as Error).message}`);
    }
  }

  const cfg = buildOpenClawConfig(rawCfg);
  const channelIds = Object.keys(rawCfg.channels ?? {});

  const results: Array<{
    channelId: string;
    accountId: string;
    status: string;
    startedAt: number;
  }> = [];

  for (const id of channelIds) {
    try {
      const started = await loadStartChannel(id, cfg);
      for (const runKey of started) {
        const [chId, ...rest] = runKey.split(":");
        results.push({
          channelId: chId,
          accountId: rest.join(":"),
          status: "running",
          startedAt: Date.now(),
        });
      }
    } catch (err) {
      console.error(`[ocg] Failed to start ${id}:`, (err as Error).message);
    }
  }
  return results;
}
