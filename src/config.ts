/**
 * Lite Gateway config loader / writer.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LiteGatewayConfig = {
  agentUrl?: string;
  model?: string;
  apiKey?: string;
  verbose?: boolean;
  channels?: Record<string, LiteGatewayChannelConfig>;
};

export type LiteGatewayChannelConfig = {
  enabled?: boolean;
  token?: string;
  [key: string]: unknown;
};

const DEFAULT_CONFIG_PATH = "lite-gateway.json";

export function resolveConfigPath(): string {
  if (process.env.LITE_GATEWAY_CONFIG_PATH) {
    return resolve(process.env.LITE_GATEWAY_CONFIG_PATH);
  }
  return resolve(DEFAULT_CONFIG_PATH);
}

export function loadConfig(): LiteGatewayConfig | null {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as LiteGatewayConfig;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: LiteGatewayConfig): void {
  const configPath = resolveConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

export function addChannel(
  channelId: string,
  token: string,
  extra: Record<string, unknown> = {},
): LiteGatewayConfig {
  const cfg = loadConfig() ?? {};
  cfg.channels ??= {};
  cfg.channels[channelId] ??= {};
  cfg.channels[channelId].enabled = true;
  cfg.channels[channelId].token = token;
  Object.assign(cfg.channels[channelId], extra);
  saveConfig(cfg);
  return cfg;
}

export function removeChannel(channelId: string): LiteGatewayConfig {
  const cfg = loadConfig();
  if (!cfg?.channels?.[channelId]) return cfg ?? {};
  delete cfg.channels[channelId];
  saveConfig(cfg);
  return cfg;
}

export function listConfiguredChannels(): string[] {
  const cfg = loadConfig();
  if (!cfg?.channels) return [];
  return Object.keys(cfg.channels).filter((id) => cfg.channels![id]?.enabled !== false);
}

export function listAllChannels(): string[] {
  const cfg = loadConfig();
  if (!cfg?.channels) return [];
  return Object.keys(cfg.channels);
}
