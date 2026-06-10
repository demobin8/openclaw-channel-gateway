/**
 * Lite Gateway — Dynamic channel plugin loader.
 *
 * Discovers and loads OpenClaw channel plugins:
 * 1. Bundled plugins: node_modules/openclaw/dist/extensions/<id>
 * 2. External plugins: node_modules/<pkg> with "openclaw.channel" in package.json
 *
 * For each plugin the loader imports the entry module, resolves the
 * ChannelPluginObject, and registers it so startChannel can call
 * gateway.startAccount.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __pluginDirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ────────────────────────────────────────────────────────────────

type ChannelPluginObject = {
  id?: string;
  meta?: { id?: string; label?: string };
  gateway?: {
    startAccount?: (ctx: Record<string, unknown>) => Promise<void>;
    stopAccount?: (ctx: Record<string, unknown>) => Promise<void>;
  };
  config?: Record<string, unknown>;
};

type ChannelEntry = {
  id?: string;
  name?: string;
  plugin?: { specifier: string; exportName: string };
  secrets?: { specifier: string; exportName: string };
  runtime?: { specifier: string; exportName: string };
  register?: (api: Record<string, unknown>) => void;
};

// ── Package root ─────────────────────────────────────────────────────────

function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.resolve(dir, "..")) {
    try {
      const pkg = JSON.parse(readFileSync(path.resolve(dir, "package.json"), "utf-8"));
      if (pkg.name === "lite-gateway") return dir;
    } catch {}
    dir = path.resolve(dir, "..");
  }
  return process.cwd();
}

// ── Discovery ────────────────────────────────────────────────────────────

type PluginCandidate = {
  id: string;
  label: string;
  pkgRoot: string;
  /** Relative entry path within pkgRoot */
  entrySpecifier: string;
};

/** Discover external plugins installed via npm in the lite-gateway node_modules. */
export function discoverExternalPlugins(): PluginCandidate[] {
  const root = findPackageRoot();
  const nmDir = path.resolve(root, "node_modules");
  if (!existsSync(nmDir)) return [];

  const results: PluginCandidate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(nmDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry === "openclaw" || entry === ".bin" || entry === ".package-lock.json") continue;

    if (entry.startsWith("@")) {
      // Scoped packages: drill into each one
      const scopedDir = path.resolve(nmDir, entry);
      if (!existsSync(scopedDir)) continue;
      try {
        const subEntries = readdirSync(scopedDir);
        for (const sub of subEntries) {
          checkExternalPkg(path.resolve(scopedDir, sub), results);
        }
      } catch { /* skip */ }
    } else {
      checkExternalPkg(path.resolve(nmDir, entry), results);
    }
  }

  return results;
}

function checkExternalPkg(pkgDir: string, results: PluginCandidate[]): void {
  const pkgPath = path.resolve(pkgDir, "package.json");
  if (!existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const oc = pkg.openclaw;
    if (!oc?.channel?.id) return;

    // External plugins may ship a compiled runtime entry (runtimeExtensions)
    // separate from the source entry (extensions). Prefer the runtime one.
    let specifier = oc.runtimeExtensions?.[0] || oc.extensions?.[0] || "./dist/index.js";

    // Normalize .ts -> .js (the plugin may reference the source entry)
    specifier = specifier.replace(/\.ts$/, ".js");

    results.push({
      id: oc.channel.id,
      label: oc.channel.label || pkg.name,
      pkgRoot: pkgDir,
      entrySpecifier: specifier,
    });
  } catch {
    // skip
  }
}

/** Discover bundled plugins shipped inside the openclaw package. */
export function discoverBundledPlugins(): PluginCandidate[] {
  const root = findPackageRoot();
  const extDir = path.resolve(root, "node_modules", "openclaw", "dist", "extensions");
  if (!existsSync(extDir)) return [];

  const results: PluginCandidate[] = [];
  let names: string[];
  try {
    names = readdirSync(extDir);
  } catch {
    return [];
  }

  for (const name of names) {
    const pkgPath = path.resolve(extDir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const oc = pkg.openclaw;
      if (!oc?.channel?.id) continue;

      const specifier = oc.extensions?.[0] || "./index.js";
      results.push({
        id: oc.channel.id,
        label: oc.channel.label || name,
        pkgRoot: path.resolve(extDir, name),
        entrySpecifier: specifier,
      });
    } catch {
      // skip invalid
    }
  }
  return results;
}

// ── Loading ──────────────────────────────────────────────────────────────

const loadedPlugins = new Map<string, ChannelPluginObject>();

/**
 * Load a single channel plugin by importing its entry module and
 * extracting the ChannelPluginObject.
 *
 * Handles two conventions:
 * - Bundled entries: default export is a ChannelEntry with plugin.specifier/exportName
 * - External (register-based): entry has a register(api) that calls api.registerChannel({...})
 */
export async function loadChannelPlugin(
  candidate: PluginCandidate,
): Promise<ChannelPluginObject | null> {
  if (loadedPlugins.has(candidate.id)) {
    return loadedPlugins.get(candidate.id)!;
  }

  try {
    // Resolve entry path to a file:// URL (ESM dynamic import requires URLs)
    const resolved = path.resolve(candidate.pkgRoot, candidate.entrySpecifier);
    const entryUrl = pathToFileURL(resolved).href;

    const entryModule = await import(entryUrl);
    const entry: ChannelEntry = entryModule.default ?? entryModule;

    if (!entry) {
      console.error(`[lite-gateway] Plugin ${candidate.id}: no default export`);
      return null;
    }

    let plugin: ChannelPluginObject | null = null;

    // Case 1: entry has plugin.specifier (bundled convention)
    if (entry.plugin?.specifier) {
      const pluginUrl = pathToFileURL(
        path.resolve(candidate.pkgRoot, entry.plugin.specifier),
      ).href;
      const pluginModule = await import(pluginUrl);
      const maybePlugin = pluginModule[entry.plugin.exportName];
      if (maybePlugin) plugin = maybePlugin as ChannelPluginObject;
      if (!plugin) {
        console.error(
          `[lite-gateway] Plugin ${candidate.id}: no export "${entry.plugin.exportName}"`,
        );
        return null;
      }

      // Inject runtime if the entry declares a runtime setter (e.g. setTelegramRuntime, setQQBotRuntime)
      if (entry.runtime?.specifier) {
        const runtimeUrl = pathToFileURL(
          path.resolve(candidate.pkgRoot, entry.runtime.specifier),
        ).href;
        try {
          const runtimeModule = await import(runtimeUrl);
          const setRuntime = runtimeModule[entry.runtime.exportName] as
            | ((rt: Record<string, unknown>) => void)
            | undefined;
          if (typeof setRuntime === "function") {
            // Provide dispatchReplyWithBufferedBlockDispatcher from our shim
            const shimDispatchUrl = pathToFileURL(
              path.resolve(__pluginDirname, "shims/reply-dispatch-runtime.js"),
            ).href;
            // Import our shim to get the HTTP dispatch function
            const { dispatchReplyWithBufferedBlockDispatcher } =
              await import(shimDispatchUrl);

            const runtime = {
              version: "1.0.0",
              channel: {
                reply: { dispatchReplyWithBufferedBlockDispatcher },
                session: { recordInboundSession: () => {} },
              },
            };
            setRuntime(runtime as Record<string, unknown>);
            console.log(`[lite-gateway] Injected runtime for ${candidate.id}`);
          }
        } catch (err) {
          console.warn(
            `[lite-gateway] Could not inject runtime for ${candidate.id}:`,
            (err as Error).message,
          );
        }
      }
    }

    // Case 2: entry has register (external plugin convention)
    if (!plugin && typeof entry.register === "function") {
      const captured: { plugin: ChannelPluginObject | null } = { plugin: null };
      const api = {
        registerChannel({ plugin: p }: { plugin: ChannelPluginObject }) {
          captured.plugin = p;
        },
        registerFull() {},
        registerCliMetadata() {},
        registerProvider() {},
        registerTool() {},
        runtime: { version: "1.0.0" },
        setChannelRuntime() {},
      };
      entry.register(api);
      plugin = captured.plugin;
    }

    if (!plugin) {
      console.error(`[lite-gateway] Plugin ${candidate.id}: could not extract ChannelPluginObject`);
      return null;
    }

    // Normalize id from plugin metadata
    if (!plugin.id && entry.id) plugin.id = entry.id;
    if (!plugin.id) plugin.id = candidate.id;

    loadedPlugins.set(candidate.id, plugin);

    console.log(
      `[lite-gateway] Loaded channel plugin: ${plugin.id} (${candidate.label}) — ` +
        `has startAccount: ${typeof plugin.gateway?.startAccount === "function"}`,
    );
    return plugin;
  } catch (err) {
    console.error(
      `[lite-gateway] Failed to load plugin ${candidate.id}:`,
      (err as Error).message,
    );
    return null;
  }
}

/** Load all bundled + external plugins. */
export async function loadAllPlugins(): Promise<void> {
  const bundled = discoverBundledPlugins();
  const external = discoverExternalPlugins();

  // Deduplicate by id (external wins over bundled when same id)
  const seen = new Set<string>();
  const all: PluginCandidate[] = [];
  for (const c of [...bundled, ...external]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    all.push(c);
  }

  for (const c of all) {
    await loadChannelPlugin(c);
  }
}

export function getChannelPlugin(id: string): ChannelPluginObject | null {
  return loadedPlugins.get(id) ?? null;
}

export function listLoadedPlugins(): string[] {
  return [...loadedPlugins.keys()];
}

// ── Starting / Stopping ──────────────────────────────────────────────────

const runningChannels = new Map<
  string,
  { stop: () => Promise<void>; abort: AbortController }
>();

export async function startChannel(
  channelId: string,
  token: string,
  extraCfg?: Record<string, unknown>,
): Promise<void> {
  const plugin = loadedPlugins.get(channelId);
  if (!plugin) throw new Error(`Plugin "${channelId}" not loaded`);

  const startFn = plugin.gateway?.startAccount;
  if (!startFn) {
    throw new Error(`Plugin "${channelId}" has no gateway.startAccount`);
  }

  const abort = new AbortController();

  // Build a minimal ChannelGatewayContext
  const channelSection: Record<string, unknown> = { token, ...extraCfg };

  const ctx = {
    cfg: { channels: { [channelId]: channelSection } },
    accountId: "default",
    account: channelSection,
    runtime: { version: "1.0.0" },
    abortSignal: abort.signal,
    log: {
      info: (...args: unknown[]) => console.log(`[${channelId}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[${channelId}]`, ...args),
      error: (...args: unknown[]) => console.error(`[${channelId}]`, ...args),
      debug: (...args: unknown[]) => console.debug(`[${channelId}]`, ...args),
    } as unknown as Record<string, (...args: unknown[]) => void> & {
      tagged: (tags: unknown, ...args: unknown[]) => void;
    },
    getStatus: () => ({}),
    setStatus: (_next: unknown) => {},
  };

  // startAccount returns a Promise<void> that resolves when the channel stops
  const task = startFn(ctx);

  runningChannels.set(channelId, {
    abort,
    stop: async () => {
      abort.abort();
      try {
        await plugin.gateway?.stopAccount?.(ctx);
      } catch { /* ignore */ }
      try {
        await Promise.race([
          task.then(() => {}).catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]);
      } catch { /* ignore */ }
      runningChannels.delete(channelId);
    },
  });

  console.log(`[lite-gateway] ${channelId} channel started`);
}

export async function stopChannel(channelId: string): Promise<void> {
  const entry = runningChannels.get(channelId);
  if (!entry) {
    console.log(`[lite-gateway] ${channelId} not running`);
    return;
  }
  await entry.stop();
}

export function isChannelRunning(channelId: string): boolean {
  return runningChannels.has(channelId);
}

export function listRunningChannels(): string[] {
  return [...runningChannels.keys()];
}

export async function stopAllChannels(): Promise<void> {
  for (const id of runningChannels.keys()) {
    await stopChannel(id);
  }
}
