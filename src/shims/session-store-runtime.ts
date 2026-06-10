/**
 * Lite gateway shim for `openclaw/plugin-sdk/session-store-runtime`.
 *
 * Provides session storage backed by a simple JSON file instead of SQLite.
 * Channel plugins use this to track session state (last-route info,
 * session metadata, etc.).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────

export type SessionEntry = Record<string, unknown>;
export type SessionScope = Record<string, unknown>;

// ── File-based store ─────────────────────────────────────────────────────

const DB_FILE = process.env.LITE_GATEWAY_SESSION_DB_PATH || "lite-gateway-sessions.json";

let _store: Map<string, SessionEntry> | null = null;

function ensureStore(): Map<string, SessionEntry> {
  if (_store !== null) return _store;
  _store = new Map();
  if (existsSync(DB_FILE)) {
    try {
      const raw = readFileSync(DB_FILE, "utf-8");
      const entries: [string, SessionEntry][] = JSON.parse(raw);
      for (const [key, entry] of entries) {
        _store.set(key, entry);
      }
    } catch (err) {
      console.error(`[lite-gateway] Failed to load sessions: ${err}`);
    }
  }
  return _store;
}

function persistStore() {
  if (!_store) return;
  try {
    const dir = dirname(pathResolve(DB_FILE));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const entries = [..._store.entries()];
    writeFileSync(DB_FILE, JSON.stringify(entries, null, 2), "utf-8");
  } catch (err) {
    console.error(`[lite-gateway] Failed to persist sessions: ${err}`);
  }
}

// ── Session entry CRUD ───────────────────────────────────────────────────

export function getSessionEntry(key: string): SessionEntry | undefined {
  return ensureStore().get(key);
}

export function listSessionEntries(): Map<string, SessionEntry> {
  return new Map(ensureStore());
}

export function upsertSessionEntry(
  key: string,
  entry: SessionEntry,
  _scope: SessionScope = {},
): void {
  const store = ensureStore();
  const existing = store.get(key);
  store.set(key, { ...existing, ...entry });
  persistStore();
}

export function patchSessionEntry(
  key: string,
  patch: SessionEntry,
  _scope: SessionScope = {},
): void {
  const store = ensureStore();
  const existing = store.get(key) ?? {};
  store.set(key, { ...existing, ...patch });
  persistStore();
}

export function updateSessionStoreEntry(
  key: string,
  updater: (entry: SessionEntry) => SessionEntry,
): void {
  const store = ensureStore();
  const existing = store.get(key) ?? {};
  store.set(key, updater(existing));
  persistStore();
}

export function updateLastRoute(key: string, route: unknown): void {
  patchSessionEntry(key, { lastRoute: route });
}

export function recordSessionMetaFromInbound(
  key: string,
  _ctx: Record<string, unknown>,
): void {
  const store = ensureStore();
  if (!store.has(key)) {
    store.set(key, { createdAt: Date.now(), lastActiveAt: Date.now() });
  } else {
    const entry = store.get(key)!;
    store.set(key, { ...entry, lastActiveAt: Date.now() });
  }
  persistStore();
}

export function readSessionUpdatedAt(key: string): number | undefined {
  const entry = ensureStore().get(key);
  return (entry?.["lastActiveAt"] ?? entry?.["createdAt"]) as number | undefined;
}

// ── Legacy / compatibility ──────────────────────────────────────────────

/**
 * @deprecated Legacy mutable-store accessor. Returns a Map for compatibility.
 */
export function loadSessionStore(): Map<string, SessionEntry> {
  return new Map(ensureStore());
}

export function saveSessionStore(): void {
  persistStore();
}

export function updateSessionStore(_store: Map<string, SessionEntry>): void {
  _store = new Map(_store);
  persistStore();
}

// ── Paths / file-based session helpers ───────────────────────────────────

export function resolveStorePath(): string {
  return DB_FILE;
}

export function resolveSessionFilePath(key: string): string {
  return DB_FILE; // Not a real path; store is in-memory JSON
}

export function resolveSessionTranscriptPathInDir(_dir: string): string {
  return "";
}

export function resolveSessionKey(
  channel: string,
  accountId: string,
  id: string,
): string {
  return `${channel}:${accountId ?? "default"}:${id}`;
}

export function resolveGroupSessionKey(
  channel: string,
  accountId: string,
  groupId: string,
): string {
  return `${channel}:${accountId ?? "default"}:group:${groupId}`;
}

export function canonicalizeMainSessionKey(key: string): string {
  return key;
}

export function resolveAndPersistSessionFile(): string {
  return DB_FILE;
}

export function readLatestAssistantTextFromSessionTranscript(): string {
  return "";
}

// ── Reset / policy ───────────────────────────────────────────────────────

export function evaluateSessionFreshness(): boolean {
  return true;
}

export function resolveChannelResetConfig(): unknown {
  return {};
}

export function resolveSessionResetPolicy(): string {
  return "keep";
}

export function resolveSessionResetType(): string {
  return "none";
}

export function resolveThreadFlag(): boolean {
  return false;
}

export function resolveSendPolicy(): string {
  return "allow";
}

// ── Targets ──────────────────────────────────────────────────────────────

export function resolveAllAgentSessionStoreTargetsSync(): string[] {
  return [];
}

// ── Test helpers ─────────────────────────────────────────────────────────

export function clearSessionStoreCacheForTest(): void {
  _store = null;
  console.log("[lite-gateway] Session store cleared for test");
}
