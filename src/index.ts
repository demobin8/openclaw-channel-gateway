/**
 * Lite Gateway — main module.
 *
 * A minimal OpenClaw channel gateway that bridges IM channels to any
 * OpenAI-compatible agent API via HTTP.
 *
 * Uses OpenClaw channel plugins directly — no code porting needed.
 * Any bundled or external OpenClaw IM plugin works out of the box.
 */

import { loadConfig, resolveConfigPath, resolveConfigDir, buildOpenClawConfig, applyConfigEnvOverrides, asAgentType, type LiteGatewayConfig } from "./config.js";
import { startAll, stopAll, listRunningChannels } from "./gateway.js";
import { stopCallbackServer, getCallbackPort } from "./callback-server.js";
import { resetMailbox } from "./mailbox.js";
import {
  clearGatewayProcessState,
  readActiveGatewayProcessState,
  writeGatewayProcessState,
  type PersistedAccountState,
} from "./process-state.js";

export {
  loadConfig,
  resolveConfigPath,
  resolveConfigDir,
  saveConfig,
  addChannel,
  removeChannel,
  removeChannelAccount,
  listConfiguredChannels,
  listAllChannels,
  getChannelSection,
  buildOpenClawConfig,
  resolveSendSettings,
} from "./config.js";
export type { LiteGatewayConfig, SendSettings } from "./config.js";
export { executeSend } from "./send-service.js";
export type { SendRequest, SendOutcome } from "./send-service.js";
export {
  startChannel,
  stopChannel,
  restartChannel,
  getChannelStatus,
  startAll,
  stopAll,
  listRunningAccounts,
} from "./gateway.js";

export async function startGateway(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) throw new Error("No config found. Create ocg.json");

  applyConfigEnvOverrides(cfg);

  const channelIds = Object.keys(cfg.channels ?? {});
  if (channelIds.length === 0) throw new Error("No channels configured");

  const results = await startAll(cfg);
  writeGatewayProcessState(
    cfg,
    results.map((r) => ({
      channelId: r.channelId,
      accountId: r.accountId,
      status: "running",
      startedAt: r.startedAt,
    })),
    {
      port: getCallbackPort() || rawCallbackPort(cfg),
      host: cfg.callbackHost ?? "0.0.0.0",
    },
  );
  // startAll reports each account individually; dedupe by channel
  const uniqueChannelIds = new Set(results.map((r) => r.channelId));
  console.log(`[ocg] ${uniqueChannelIds.size} channel(s) running (${results.length} account(s))`);
}

/** The configured callback port (the bound port is preferred when listening). */
function rawCallbackPort(cfg: LiteGatewayConfig): number | undefined {
  return cfg.callbackPort;
}

export async function stopGateway(): Promise<void> {
  await stopAll();
  await stopCallbackServer();
  resetMailbox();
  clearGatewayProcessState();
}

export function gatewayStatus(): Record<string, unknown> {
  const inProcessRunning = listRunningChannels();
  const processState = inProcessRunning.length > 0 ? null : readActiveGatewayProcessState();
  const running: PersistedAccountState[] = inProcessRunning.length > 0
    ? inProcessRunning.map((entry) => ({
      channelId: entry.channelId,
      accountId: "default",
      status: entry.status,
      startedAt: entry.startedAt,
      error: entry.error,
    }))
    : (processState?.accounts ?? []);
  const cfg = loadConfig();
  const configured = cfg?.channels ? Object.keys(cfg.channels) : [];

  // Collect per-channel agentUrls
  const channelAgentUrls: Record<string, string> = {};
  if (cfg?.channels) {
    for (const [chId, chCfg] of Object.entries(cfg.channels)) {
      const ch = chCfg as Record<string, unknown>;
      if (ch.agentUrl && typeof ch.agentUrl === "string") {
        channelAgentUrls[chId] = ch.agentUrl;
      }
    }
  }

  const agentType = asAgentType(cfg?.agentType) ?? (cfg?.acp ? "acp" : asAgentType(process.env.OCG_AGENT_TYPE)) ?? "http";

  const typeUrl = (type: string, url: string | undefined): string =>
    type === "acp" ? "acp://stdio" : type === "mailbox" ? "mailbox://local" : (url ?? "(not set)");

  return {
    configured: configured.length,
    running: new Set(running.map((b) => b.channelId)).size,
    channels: running.map((b) => {
      const channelCfg = cfg?.channels?.[b.channelId] as Record<string, unknown> | undefined;
      const channelAgentType = asAgentType(channelCfg?.agentType) ?? (channelCfg?.acp ? "acp" : agentType);
      // Show per-channel agentUrl if set, otherwise fall back to global
      const chAgentUrl = typeUrl(
        channelAgentType,
        channelAgentUrls[b.channelId] || cfg?.agentUrl || processState?.agentUrl || process.env.OCG_AGENT_URL,
      );
      return {
        id: b.channelId,
        accountId: "accountId" in b ? b.accountId : undefined,
        status: b.status,
        uptime: b.startedAt ? Math.round((Date.now() - b.startedAt) / 1000) : 0,
        error: b.error,
        agentUrl: chAgentUrl,
        agentType: channelAgentType,
      };
    }),
    pid: processState?.pid,
    agentType,
    agentUrl: typeUrl(agentType, cfg?.agentUrl || processState?.agentUrl || process.env.OCG_AGENT_URL),
    acp: cfg?.acp,
    model: cfg?.model || processState?.model || process.env.OCG_MODEL || "(not set)",
  };
}
