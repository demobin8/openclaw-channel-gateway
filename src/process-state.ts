import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir, resolveConfigPath, type LiteGatewayConfig } from "./config.js";

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
  accounts: PersistedAccountState[];
};

const STATE_FILE = "ocg-state.json";

export function resolveGatewayProcessStatePath(): string {
  return join(resolveConfigDir(), STATE_FILE);
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
): void {
  const now = Date.now();
  const state: GatewayProcessState = {
    pid: process.pid,
    startedAt: now,
    configPath: resolveConfigPath(),
    agentUrl: cfg.agentUrl || process.env.OCG_AGENT_URL,
    model: cfg.model || process.env.OCG_MODEL,
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
