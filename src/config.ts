/**
 * Lite Gateway config loader / writer.
 *
 * Config format (ocg.json):
 *   - Top-level lite-gateway settings: agentUrl, model, apiKey, verbose
 *   - channels section follows OpenClaw format:
 *       channels.<id>.accounts.<accountId>
 *
 * Example:
 *   {
 *     "agentUrl": "http://127.0.0.1:11434/v1/chat/completions",
 *     "model": "gpt-4o",
 *     "apiKey": "",
 *     "channels": {
 *       "telegram": {
 *         "accounts": {
 *           "default": { "enabled": true, "botToken": "..." }
 *         }
 *       }
 *     }
 *   }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export type LiteGatewayConfig = {
  /** OpenAI-compatible agent API endpoint */
  agentUrl?: string;
  /** Model name */
  model?: string;
  /** API key for the agent */
  apiKey?: string;
  /** Verbose logging */
  verbose?: boolean;
  /**
   * Async dispatch mode: fire & forget the agent request, then wait for
   * the agent backend to call back on /ocg/callback with the reply.
   * Default: false (synchronous, wait for agent response inline).
   */
  async?: boolean;
  /** Port for the callback HTTP server (default 3457) */
  callbackPort?: number;
  /** Host for the callback HTTP server (default "127.0.0.1") */
  callbackHost?: string;
  /** Shared secret for HMAC callback signature verification (optional) */
  callbackSecret?: string;
  /** Callback token TTL in seconds (default 1800 = 30 minutes) */
  callbackTokenTTL?: number;
  /** OpenClaw-compatible channel configs */
  channels?: Record<string, Record<string, unknown>>;
};

const DEFAULT_CONFIG_DIR = join(homedir(), ".openclaw-channel-gateway");
const DEFAULT_CONFIG_FILE = "ocg.json";

/** Return the config directory (~/.openclaw-channel-gateway), created on demand. */
export function resolveConfigDir(): string {
  if (!existsSync(DEFAULT_CONFIG_DIR)) {
    mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  }
  return DEFAULT_CONFIG_DIR;
}

export function resolveConfigPath(): string {
  if (process.env.OCG_CONFIG_PATH) {
    return resolve(process.env.OCG_CONFIG_PATH);
  }
  return join(resolveConfigDir(), DEFAULT_CONFIG_FILE);
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

/**
 * Build an OpenClaw-compatible config object suitable for passing to
 * channel plugins' config adapters. Merges lite-gateway settings into
 * a `liteGateway` key so the dispatch shim can read them.
 */
export function buildOpenClawConfig(raw: LiteGatewayConfig): Record<string, unknown> {
  return {
    ...raw,
    liteGateway: {
      agentUrl: raw.agentUrl,
      model: raw.model,
      apiKey: raw.apiKey,
      verbose: raw.verbose,
      async: raw.async ?? false,
      callbackUrl: `http://${raw.callbackHost ?? "127.0.0.1"}:${raw.callbackPort ?? 3457}/ocg/callback`,
      callbackSecret: raw.callbackSecret,
      callbackTokenTTL: raw.callbackTokenTTL,
    },
  };
}

/**
 * Inject config-driven values into process.env as safe defaults.
 *
 * Some plugins use the openclaw runtime config (not our built config)
 * so cfg.liteGateway may not be visible to dispatch.  Setting env vars
 * gives every dispatch path a reliable fallback.
 *
 * Does NOT overwrite explicitly set env vars.
 */
export function applyConfigEnvOverrides(raw: LiteGatewayConfig): void {
  if (raw.agentUrl && !process.env.OCG_AGENT_URL) {
    process.env.OCG_AGENT_URL = raw.agentUrl;
    console.log(`[ocg] OCG_AGENT_URL set from config: ${raw.agentUrl}`);
  } else {
    console.log(`[ocg] OCG_AGENT_URL skipped: raw.agentUrl=${raw.agentUrl}, env.OCG_AGENT_URL=${process.env.OCG_AGENT_URL}`);
  }
  if (raw.model && !process.env.OCG_MODEL) {
    process.env.OCG_MODEL = raw.model;
  }
  if (raw.apiKey && !process.env.OCG_API_KEY) {
    process.env.OCG_API_KEY = raw.apiKey;
  }
  if (raw.verbose && !process.env.OCG_VERBOSE) {
    process.env.OCG_VERBOSE = "1";
  }
}

/**
 * Add a channel account entry in OpenClaw format.
 * Creates channels.<id>.accounts.<accountId> with the given fields.
 */
export function addChannel(
  channelId: string,
  accountId: string,
  fields: Record<string, unknown> = {},
): LiteGatewayConfig {
  const cfg = loadConfig() ?? {};
  cfg.channels ??= {};

  const section = (cfg.channels[channelId] ?? {}) as Record<string, unknown>;

  if (accountId === "default") {
    // Default account → set at channel level (most plugins read channel root)
    Object.assign(section, { enabled: true, ...section, ...fields });
  } else {
    // Named account → nest under accounts.<id>
    section.accounts ??= {};
    const accounts = section.accounts as Record<string, Record<string, unknown>>;
    accounts[accountId] = {
      enabled: true,
      ...accounts[accountId],
      ...fields,
    };
  }

  cfg.channels[channelId] = section;
  saveConfig(cfg);
  return cfg;
}

/**
 * Remove an entire channel from config.
 */
export function removeChannel(channelId: string): LiteGatewayConfig {
  const cfg = loadConfig();
  if (!cfg?.channels?.[channelId]) return cfg ?? {};
  delete cfg.channels[channelId];
  saveConfig(cfg);
  return cfg;
}

/**
 * Remove a specific account from a channel.
 */
export function removeChannelAccount(
  channelId: string,
  accountId: string,
): LiteGatewayConfig {
  const cfg = loadConfig();
  if (!cfg?.channels?.[channelId]) return cfg ?? {};
  const section = cfg.channels[channelId] as Record<string, unknown>;
  const accounts = section.accounts as Record<string, unknown> | undefined;
  if (accounts) {
    delete accounts[accountId];
  }
  saveConfig(cfg);
  return cfg;
}

/**
 * List channel IDs that have at least one enabled account.
 */
export function listConfiguredChannels(): string[] {
  const cfg = loadConfig();
  if (!cfg?.channels) return [];
  return Object.keys(cfg.channels).filter((id) => {
    const section = cfg.channels![id] as Record<string, unknown>;
    // Check if any account is enabled
    const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;
    if (!accounts) return section.enabled !== false;
    return Object.values(accounts).some((a) => a?.enabled !== false);
  });
}

/** List all channel IDs in config (including disabled). */
export function listAllChannels(): string[] {
  const cfg = loadConfig();
  if (!cfg?.channels) return [];
  return Object.keys(cfg.channels);
}

/** Get raw channel section config (for passing to plugin adapter). */
export function getChannelSection(channelId: string): Record<string, unknown> | null {
  const cfg = loadConfig();
  return (cfg?.channels?.[channelId] as Record<string, unknown>) ?? null;
}
