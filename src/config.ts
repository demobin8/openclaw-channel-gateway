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

/**
 * Agent transport type.
 *
 * - `http`    — OpenAI-compatible Chat Completions endpoint (default)
 * - `acp`     — local ACP stdio agent subprocess
 * - `mailbox` — inbound messages are queued in the daemon and pulled by a
 *               short-lived CLI (`ocg inbox wait` / `ocg reply`); see
 *               docs/techdesign-agent-cli.md
 */
export type AgentType = "http" | "acp" | "mailbox";

export const AGENT_TYPES: readonly AgentType[] = ["http", "acp", "mailbox"];

export function asAgentType(value: unknown): AgentType | undefined {
  return typeof value === "string" && (AGENT_TYPES as readonly string[]).includes(value)
    ? (value as AgentType)
    : undefined;
}

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
  /**
   * Proactive send: enable the /ocg/send endpoint and `ocg send`.
   * Default: enabled when a secret is configured (see sendSecret/callbackSecret).
   * Explicit false disables the capability entirely.
   */
  sendEnabled?: boolean;
  /** HMAC shared secret for /ocg/send. Falls back to callbackSecret. */
  sendSecret?: string;
  /** Optional channel whitelist for proactive send. Unset = all configured channels. */
  sendAllowedChannels?: string[];
  /** Hard limit for send text length. Unset = use the plugin's textChunkLimit. */
  sendMaxTextLength?: number;
  /** Max request body size for /ocg/send in bytes (default 1048576 = 1 MiB). */
  sendMaxBodyBytes?: number;
  /** Proactive send timeout in milliseconds (default 30000). */
  sendTimeoutMs?: number;
  /** Prefix each outbound chunk with "[i/n]" like the reply path (default false). */
  sendChunkPrefix?: boolean;
  // ── Mailbox transport (agentType: "mailbox") ────────────────────────────
  /** Lease duration for a pulled message in milliseconds (default 300000 = 5 min). */
  mailboxLeaseMs?: number;
  /** Reply-handle TTL in seconds. Falls back to callbackTokenTTL, then 1800. */
  mailboxReplyTTL?: number;
  /** Max queued (pending) messages; the oldest pending message is dropped beyond it (default 1000). */
  mailboxMaxPending?: number;
  /** Lease-expiry redeliveries before a message is marked expired (default 5). */
  mailboxMaxRedeliveries?: number;
  /** Download remote inbound media into the mailbox media dir (default true). */
  mailboxDownloadMedia?: boolean;
  /** Days to keep downloaded media (default 7). */
  mailboxMediaRetentionDays?: number;
  /** Days to keep done entries in the mailbox JSONL log (default 30). */
  mailboxHistoryRetentionDays?: number;
  /**
   * Max done entries kept in memory / in the snapshot (default 2000). The
   * oldest done entries are evicted beyond it; set -1 for unbounded.
   */
  mailboxMaxDone?: number;
  /** Session model (OpenClaw-compatible) */
  session?: {
    /** DM session isolation scope: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer". Defaults to "per-channel-peer". */
    dmScope?: string;
  };
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
    session: {
      dmScope: raw.session?.dmScope ?? "per-channel-peer",
    },
    liteGateway: {
      agentType: raw.agentType ?? (raw.acp ? "acp" : "http"),
      agentUrl: raw.agentUrl,
      acp: raw.acp,
      model: raw.model,
      apiKey: raw.apiKey,
      verbose: raw.verbose,
      async: raw.async ?? false,
      callbackPublicHost: raw.callbackPublicHost,
      callbackPublicPort: raw.callbackPublicPort,
      callbackHost: raw.callbackPublicHost ?? raw.callbackHost,
      callbackPort: raw.callbackPublicPort ?? raw.callbackPort,
      callbackUrl: `http://${raw.callbackPublicHost ?? raw.callbackHost ?? "127.0.0.1"}:${raw.callbackPublicPort ?? raw.callbackPort ?? 3457}/ocg/callback`,
      callbackSecret: raw.callbackSecret,
      callbackTokenTTL: raw.callbackTokenTTL,
      replyChunkSize: raw.replyChunkSize,
    },
  };
}

// ── Proactive send settings ────────────────────────────────────────────────

export const DEFAULT_SEND_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/** Normalized proactive-send settings derived from config. */
export type SendSettings = {
  /** Capability is usable: sendEnabled !== false AND a secret is available. */
  enabled: boolean;
  /** HMAC shared secret (sendSecret, falling back to callbackSecret). */
  secret: string | null;
  /** Channel whitelist, or null when every configured channel is allowed. */
  allowedChannels: string[] | null;
  /** Hard text-length limit, or null when the plugin's chunk limit applies. */
  maxTextLength: number | null;
  maxBodyBytes: number;
  timeoutMs: number;
  /** Prefix each chunk with "[i/n]" (reply-path compatibility). */
  chunkPrefix: boolean;
};

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Resolve proactive-send settings.
 *
 * Enabled rule (see requirements doc FR-7): the capability requires a shared
 * secret — `sendEnabled: false` disables it explicitly, and with no secret at
 * all the endpoint reports `403 DISABLED` so an unauthenticated sandbox can
 * never send on behalf of the gateway.
 */
export function resolveSendSettings(raw: LiteGatewayConfig | null | undefined): SendSettings {
  const cfg = raw ?? {};
  const secret = (cfg.sendSecret?.trim() || cfg.callbackSecret?.trim() || "") || null;
  const allowed = Array.isArray(cfg.sendAllowedChannels)
    ? cfg.sendAllowedChannels.filter((id): id is string => typeof id === "string" && id.trim() !== "")
    : null;
  const maxTextLength = cfg.sendMaxTextLength === undefined
    ? null
    : positiveInt(cfg.sendMaxTextLength, 0) || null;

  return {
    enabled: cfg.sendEnabled !== false && secret !== null,
    secret,
    allowedChannels: allowed && allowed.length > 0 ? allowed : null,
    maxTextLength,
    maxBodyBytes: positiveInt(cfg.sendMaxBodyBytes, DEFAULT_SEND_MAX_BODY_BYTES),
    timeoutMs: positiveInt(cfg.sendTimeoutMs, DEFAULT_SEND_TIMEOUT_MS),
    chunkPrefix: cfg.sendChunkPrefix === true,
  };
}

// ── Mailbox settings ──────────────────────────────────────────────────────

export const DEFAULT_MAILBOX_LEASE_MS = 5 * 60_000;
export const DEFAULT_MAILBOX_REPLY_TTL_SECONDS = 1800;
export const DEFAULT_MAILBOX_MAX_PENDING = 1000;
export const DEFAULT_MAILBOX_MAX_REDELIVERIES = 5;
export const DEFAULT_MAILBOX_MEDIA_RETENTION_DAYS = 7;
export const DEFAULT_MAILBOX_HISTORY_RETENTION_DAYS = 30;
export const DEFAULT_MAILBOX_MAX_DONE = 2000;

/** Normalized mailbox settings derived from config (all optional keys). */
export type MailboxSettings = {
  /** Lease duration in milliseconds. */
  leaseMs: number;
  /** Reply-handle TTL in milliseconds. */
  replyTtlMs: number;
  maxPending: number;
  maxRedeliveries: number;
  downloadMedia: boolean;
  mediaRetentionDays: number;
  historyRetentionDays: number;
  /** Size bound for done entries kept in memory; -1 = unbounded. */
  maxDone: number;
};

/**
 * Resolve mailbox settings. Every key is optional; missing values fall back to
 * the defaults listed in docs/techdesign-agent-cli.md §5.13.
 */
export function resolveMailboxSettings(raw?: LiteGatewayConfig | null): MailboxSettings {
  const cfg = raw ?? {};
  const replyTtlSeconds = positiveInt(
    cfg.mailboxReplyTTL,
    positiveInt(cfg.callbackTokenTTL, DEFAULT_MAILBOX_REPLY_TTL_SECONDS),
  );
  return {
    leaseMs: positiveInt(cfg.mailboxLeaseMs, DEFAULT_MAILBOX_LEASE_MS),
    replyTtlMs: replyTtlSeconds * 1000,
    maxPending: positiveInt(cfg.mailboxMaxPending, DEFAULT_MAILBOX_MAX_PENDING),
    maxRedeliveries: nonNegativeInt(cfg.mailboxMaxRedeliveries, DEFAULT_MAILBOX_MAX_REDELIVERIES),
    downloadMedia: cfg.mailboxDownloadMedia !== false,
    mediaRetentionDays: positiveInt(
      cfg.mailboxMediaRetentionDays,
      DEFAULT_MAILBOX_MEDIA_RETENTION_DAYS,
    ),
    historyRetentionDays: positiveInt(
      cfg.mailboxHistoryRetentionDays,
      DEFAULT_MAILBOX_HISTORY_RETENTION_DAYS,
    ),
    maxDone: cfg.mailboxMaxDone === -1 ? -1 : nonNegativeInt(cfg.mailboxMaxDone, DEFAULT_MAILBOX_MAX_DONE),
  };
}

/**
 * Whether mailbox mode is configured anywhere: the global `agentType` or any
 * channel-level `agentType`. Used by the `/ocg/inbox*` routes to answer
 * `MAILBOX_DISABLED` before touching the queue.
 */
export function isMailboxConfigured(cfg: Record<string, unknown> | null | undefined): boolean {
  if (!cfg) return false;
  const liteGw = (cfg.liteGateway ?? {}) as Record<string, unknown>;
  if (asAgentType(liteGw.agentType) === "mailbox") return true;
  if (asAgentType(cfg.agentType) === "mailbox") return true;
  const channels = cfg.channels as Record<string, Record<string, unknown>> | undefined;
  if (!channels) return false;
  return Object.values(channels).some(
    (section) => section && typeof section === "object" && asAgentType(section.agentType) === "mailbox",
  );
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
    const channelType = asAgentType(chCfg?.agentType);
    if (channelType) {
      return channelType;
    }
    if (chCfg?.acp && typeof chCfg.acp === "object") {
      return "acp";
    }
  }

  const liteGw = (cfg.liteGateway ?? {}) as Record<string, unknown>;
  const globalType = asAgentType(liteGw.agentType);
  if (globalType) {
    return globalType;
  }
  if (liteGw.acp && typeof liteGw.acp === "object") {
    return "acp";
  }
  const envType = asAgentType(process.env.OCG_AGENT_TYPE);
  if (envType) return envType;
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
