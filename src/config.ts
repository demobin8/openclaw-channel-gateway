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

export type AcpGatewayConfig = {
  /** ACP-capable binary, e.g. claude-agent-acp, codex-acp, codex */
  command?: string;
  /** Extra command args, e.g. ["app-server", "--listen", "stdio://"] for Codex */
  args?: string[];
  /** Working directory used by ACP sessions */
  cwd?: string;
  /** Extra environment variables for the ACP subprocess */
  env?: Record<string, string>;
  /** Request timeout in milliseconds (default 300000) */
  timeoutMs?: number;
};

export type AgentType = "http" | "acp";

export type LiteGatewayConfig = {
  /** Agent transport type. Defaults to "http" for backward compatibility. */
  agentType?: AgentType;
  /** OpenAI-compatible agent API endpoint (HTTP mode) */
  agentUrl?: string;
  /** ACP subprocess settings (ACP mode) */
  acp?: AcpGatewayConfig;
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
  /** Host for the callback HTTP server (default "0.0.0.0" — all interfaces). In X-OCG-Callback header, 0.0.0.0 is rewritten to 127.0.0.1. */
  callbackHost?: string;
  /** Public host advertised in X-OCG-Callback when callback traffic is proxied */
  callbackPublicHost?: string;
  /** Public port advertised in X-OCG-Callback when callback traffic is proxied */
  callbackPublicPort?: number;
  /** Shared secret for HMAC callback signature verification (optional) */
  callbackSecret?: string;
  /** Callback token TTL in seconds (default 1800 = 30 minutes) */
  callbackTokenTTL?: number;
  /** Max characters per outbound reply chunk (default 4000) */
  replyChunkSize?: number;
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
      agentType: raw.agentType ?? (raw.acp ? "acp" : "http"),
      agentUrl: raw.agentUrl,
      acp: raw.acp,
      model: raw.model,
      apiKey: raw.apiKey,
      verbose: raw.verbose,
      async: raw.async ?? false,
      callbackHost: raw.callbackPublicHost ?? raw.callbackHost,
      callbackPort: raw.callbackPublicPort ?? raw.callbackPort,
      callbackUrl: `http://${raw.callbackPublicHost ?? raw.callbackHost ?? "127.0.0.1"}:${raw.callbackPublicPort ?? raw.callbackPort ?? 3457}/ocg/callback`,
      callbackSecret: raw.callbackSecret,
      callbackTokenTTL: raw.callbackTokenTTL,
      replyChunkSize: raw.replyChunkSize,
    },
  };
}

/**
 * Resolve the agent runtime URL for a specific channel.
 *
 * Priority:
 *   1. Channel-level `agentUrl` in `cfg.channels.<channelId>.agentUrl`
 *   2. Global `agentUrl` in `cfg.liteGateway.agentUrl`
 *   3. `process.env.OCG_AGENT_URL`
 *   4. Fallback: `http://127.0.0.1:11434/v1/chat/completions`
 *
 * @param channelId - Channel identifier extracted from SessionKey
 * @param cfg       - Full OpenClaw config (with liteGateway + channels)
 */
function resolveChannelSection(
  channelId: string | undefined,
  cfg: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!channelId) return undefined;
  const channels = cfg.channels as Record<string, Record<string, unknown>> | undefined;
  const direct = channels?.[channelId];
  if (direct) return direct;

  // Some plugin dispatchers pass a reduced/normalized runtime config where
  // channel sections are not preserved. In that case, fall back to the source
  // lite gateway config on disk for transport selection.
  try {
    const raw = loadConfig();
    return raw?.channels?.[channelId] as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

export function resolveChannelAgentType(
  channelId: string | undefined,
  cfg: Record<string, unknown>,
): AgentType {
  if (channelId) {
    const chCfg = resolveChannelSection(channelId, cfg);
    if (chCfg?.agentType === "acp" || chCfg?.agentType === "http") {
      return chCfg.agentType;
    }
    if (chCfg?.acp && typeof chCfg.acp === "object") {
      return "acp";
    }
  }

  const liteGw = (cfg.liteGateway ?? {}) as Record<string, unknown>;
  if (liteGw.agentType === "acp" || liteGw.agentType === "http") {
    return liteGw.agentType;
  }
  if (liteGw.acp && typeof liteGw.acp === "object") {
    return "acp";
  }
  if (process.env.OCG_AGENT_TYPE === "acp") return "acp";
  return "http";
}

export function resolveChannelAcpConfig(
  channelId: string | undefined,
  cfg: Record<string, unknown>,
): AcpGatewayConfig {
  const liteGw = (cfg.liteGateway ?? {}) as Record<string, unknown>;
  const globalAcp = liteGw.acp && typeof liteGw.acp === "object"
    ? (liteGw.acp as AcpGatewayConfig)
    : {};

  let channelAcp: AcpGatewayConfig = {};
  if (channelId) {
    const chCfg = resolveChannelSection(channelId, cfg);
    if (chCfg?.acp && typeof chCfg.acp === "object") {
      channelAcp = chCfg.acp as AcpGatewayConfig;
    }
  }

  return {
    ...globalAcp,
    ...channelAcp,
    model: (channelAcp as Record<string, unknown>).model as string | undefined ??
      (globalAcp as Record<string, unknown>).model as string | undefined ??
      (liteGw.model as string | undefined) ??
      process.env.OCG_MODEL,
  } as AcpGatewayConfig & { model?: string };
}

function contextString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean" || value instanceof String) {
    const text = String(value).trim();
    return text || undefined;
  }
  return undefined;
}

function channelPrefix(value: unknown): string | undefined {
  const text = contextString(value);
  if (!text || !text.includes(":")) return undefined;
  const first = text.split(":")[0]?.trim();
  return first && first !== "agent" ? first : undefined;
}

export function resolveChannelIdFromContext(ctx: Record<string, unknown>): string | undefined {
  const direct = contextString(ctx.ChannelId ?? ctx.channelId ?? ctx.Channel ?? ctx.channel) ??
    contextString(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
  if (direct && direct !== "agent") return direct;

  return channelPrefix(ctx.From ?? ctx.from) ??
    channelPrefix(ctx.To ?? ctx.to) ??
    channelPrefix(ctx.SessionKey ?? ctx.sessionKey ?? ctx.routeSessionKey);
}

export function resolveChannelAgentUrl(
  channelId: string | undefined,
  cfg: Record<string, unknown>,
): string {
  if (channelId) {
    const chCfg = resolveChannelSection(channelId, cfg);
    if (chCfg?.agentUrl && typeof chCfg.agentUrl === "string") {
      return chCfg.agentUrl;
    }
  }

  const liteGw = (cfg.liteGateway ?? {}) as Record<string, unknown>;
  return (liteGw.agentUrl as string) ||
    process.env.OCG_AGENT_URL ||
    "http://127.0.0.1:11434/v1/chat/completions";
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
  const agentType = raw.agentType ?? (raw.acp ? "acp" : undefined);
  if (agentType && !process.env.OCG_AGENT_TYPE) {
    process.env.OCG_AGENT_TYPE = agentType;
  }
  if (raw.acp?.command && !process.env.OCG_ACP_COMMAND) {
    process.env.OCG_ACP_COMMAND = raw.acp.command;
  }
  if (raw.acp?.args && !process.env.OCG_ACP_ARGS) {
    process.env.OCG_ACP_ARGS = JSON.stringify(raw.acp.args);
  }
  if (raw.acp?.cwd && !process.env.OCG_ACP_CWD) {
    process.env.OCG_ACP_CWD = raw.acp.cwd;
  }
  if (raw.acp?.timeoutMs && !process.env.OCG_ACP_TIMEOUT_MS) {
    process.env.OCG_ACP_TIMEOUT_MS = String(raw.acp.timeoutMs);
  }
  if (raw.acp?.env) {
    for (const [key, value] of Object.entries(raw.acp.env)) {
      const envKey = `OCG_ACP_ENV_${key}`;
      if (!process.env[envKey]) process.env[envKey] = value;
    }
  }
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
  if (raw.replyChunkSize && !process.env.OCG_REPLY_CHUNK_SIZE) {
    process.env.OCG_REPLY_CHUNK_SIZE = String(raw.replyChunkSize);
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
