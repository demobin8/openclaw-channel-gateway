import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfigPath, type LiteGatewayConfig } from "./config.js";

export type PersistedAccountState = {
  channelId: string;
  accountId: string;
  status: "running";
  startedAt: number;
  error?: string;
};

export type GatewayProcessState = {
  pid: number;
  startedAt: number;
  configPath: string;
  agentUrl?: string;
  model?: string;
  /** Actual bound callback-server port (may differ from the configured one). */
  callbackPort?: number;
  /** Configured callback-server bind host ("0.0.0.0" by default). */
  callbackHost?: string;
  accounts: PersistedAccountState[];
};

const STATE_FILE = "ocg-state.json";

/**
 * State file path — next to the config file, so `OCG_CONFIG_PATH` isolates a
 * full instance (state, token, mailbox, logs), not just the JSON config.
 */
export function resolveGatewayProcessStatePath(): string {
  return join(dirname(resolveConfigPath()), STATE_FILE);
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function readGatewayProcessState(): GatewayProcessState | null {
  const statePath = resolveGatewayProcessStatePath();
  if (!existsSync(statePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as GatewayProcessState;
    if (!Number.isInteger(parsed.pid) || !Array.isArray(parsed.accounts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readActiveGatewayProcessState(): GatewayProcessState | null {
  const state = readGatewayProcessState();
  if (!state) return null;
  if (isProcessRunning(state.pid)) return state;

  clearGatewayProcessState(state.pid);
  return null;
}

export function writeGatewayProcessState(
  cfg: LiteGatewayConfig,
  accounts: PersistedAccountState[],
  callback?: { port?: number; host?: string },
): void {
  const now = Date.now();
  const state: GatewayProcessState = {
    pid: process.pid,
    startedAt: now,
    configPath: resolveConfigPath(),
    agentUrl: cfg.agentUrl || process.env.OCG_AGENT_URL,
    model: cfg.model || process.env.OCG_MODEL,
    ...(callback?.port ? { callbackPort: callback.port } : {}),
    ...(callback?.host ? { callbackHost: callback.host } : {}),
    accounts: accounts.map((account) => ({
      ...account,
      startedAt: account.startedAt || now,
      status: "running",
    })),
  };

  writeFileSync(resolveGatewayProcessStatePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function clearGatewayProcessState(pid = process.pid): void {
  const statePath = resolveGatewayProcessStatePath();
  if (!existsSync(statePath)) return;

  const state = readGatewayProcessState();
  if (state && state.pid !== pid) return;

  try {
    unlinkSync(statePath);
  } catch {
    // Ignore cleanup failures.
  }
}
