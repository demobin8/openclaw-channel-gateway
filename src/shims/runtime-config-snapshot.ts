/**
 * Lite gateway shim for `openclaw/plugin-sdk/runtime-config-snapshot`.
 *
 * Provides a simple in-memory config store that channel plugins read from.
 * The config is loaded from `ocg.json` (in the working directory)
 * rather than from `~/.openclaw/openclaw.json`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let _runtimeConfig: Record<string, unknown> | null = null;
let _sourceConfig: Record<string, unknown> | null = null;
let _configTime: number | null = null;

function resolveConfigFile(): string {
  if (process.env.OCG_CONFIG_PATH) return process.env.OCG_CONFIG_PATH;
  return join(homedir(), ".openclaw-channel-gateway", "ocg.json");
}

const CONFIG_FILE = resolveConfigFile();

function readConfigFile() {
  if (!existsSync(CONFIG_FILE)) {
    console.log(`[ocg] No config file at ${CONFIG_FILE}, using defaults`);
    return {};
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[ocg] Failed to parse ${CONFIG_FILE}: ${err}`);
    return {};
  }
}

function loadConfig() {
  if (_runtimeConfig !== null) return;
  _configTime = Date.now();
  _sourceConfig = readConfigFile();
  _runtimeConfig = structuredClone(_sourceConfig) as Record<string, unknown>;
  console.log(`[ocg] Config loaded from ${CONFIG_FILE}`);
}

/** Return the current runtime config snapshot. */
export function getRuntimeConfigSnapshot() {
  loadConfig();
  return _runtimeConfig;
}

/** Return the raw source config snapshot. */
export function getRuntimeConfigSourceSnapshot() {
  loadConfig();
  return _sourceConfig;
}

/** Return the current runtime config. */
export function getRuntimeConfig() {
  loadConfig();
  return _runtimeConfig;
}

/** Store a new config snapshot. */
export function setRuntimeConfigSnapshot(cfg: Record<string, unknown>) {
  _runtimeConfig = structuredClone(cfg) as Record<string, unknown>;
  _configTime = Date.now();
}

/** Select applicable config from a provided list. */
export function selectApplicableRuntimeConfig(cfgs: Record<string, unknown>[]) {
  return cfgs[0] ?? _runtimeConfig ?? {};
}

/** Clear the in-memory config snapshot. */
export function clearRuntimeConfigSnapshot() {
  _runtimeConfig = null;
  _sourceConfig = null;
  _configTime = null;
}

/** Clear the config I/O cache. */
export function clearConfigCache() {
  clearRuntimeConfigSnapshot();
}

// Re-export the OpenClawConfig type from the real package
export type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
