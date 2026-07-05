/**
 * Lite Gateway — Dynamic channel plugin loader.
 *
 * Discovers and loads OpenClaw channel plugins:
 * 1. Bundled plugins: node_modules/openclaw/dist/extensions/<id>
 * 2. External plugins: node_modules/<pkg> with "openclaw.channel" in package.json
 *
 * For each plugin the loader imports the entry module, resolves the
 * ChannelPluginObject, and registers it so startChannel can call
 * gateway.startAccount using the plugin's own config adapter.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __pluginDirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ────────────────────────────────────────────────────────────────

/** Resolved account shape returned by a plugin's config.resolveAccount() */
type ResolvedAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  [key: string]: unknown;
};

/** Minimal config adapter exposed by OpenClaw channel plugins */
type ChannelConfigAdapter = {
  listAccountIds: (cfg: Record<string, unknown>) => string[];
  resolveAccount: (cfg: Record<string, unknown>, accountId?: string | null) => ResolvedAccount;
  defaultAccountId?: (cfg: Record<string, unknown>) => string;
  isEnabled?: (account: ResolvedAccount, cfg: Record<string, unknown>) => boolean;
  isConfigured?: (
    account: ResolvedAccount,
    cfg: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
  unconfiguredReason?: (account: ResolvedAccount, cfg: Record<string, unknown>) => string;
  [key: string]: unknown;
};

/** ChannelPlugin object shape loaded from an OpenClaw-compatible plugin */
type ChannelPluginObject = {
  id?: string;
  meta?: { id?: string; label?: string };
  gateway?: {
    startAccount?: (ctx: Record<string, unknown>) => Promise<unknown>;
    stopAccount?: (ctx: Record<string, unknown>) => Promise<void>;
    logoutAccount?: (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;
    loginWithQrStart?: (params: Record<string, unknown>) => Promise<{
      qrDataUrl?: string;
      message?: string;
      sessionKey?: string;
    }>;
    loginWithQrWait?: (params: Record<string, unknown>) => Promise<{
      connected?: boolean;
      message?: string;
      accountId?: string;
    }>;
  };
  config?: ChannelConfigAdapter;
  capabilities?: { chatTypes?: string[]; [key: string]: unknown };
  [key: string]: unknown;
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
      if (pkg.name === "openclaw-channel-gateway") return dir;
    } catch {
      // continue
    }
    dir = path.resolve(dir, "..");
  }
  return process.cwd();
}

/** Read the installed OpenClaw version for runtime compatibility. */
function getOpenClawVersion(): string {
  const root = findPackageRoot();
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(root, "node_modules", "openclaw", "package.json"), "utf-8"),
    );
    return pkg.version as string;
  } catch {
    return "unknown";
  }
}

// Cache the version
let _openclawVersion: string | null = null;
function openclawVersion(): string {
  if (_openclawVersion === null) _openclawVersion = getOpenClawVersion();
  return _openclawVersion;
}

// ── Discovery ────────────────────────────────────────────────────────────

type PluginCandidate = {
  id: string;
  label: string;
  pkgRoot: string;
  /** Relative entry path within pkgRoot */
  entrySpecifier: string;
};

/** Discover external plugins installed via npm in the ocg node_modules. */
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
      const scopedDir = path.resolve(nmDir, entry);
      if (!existsSync(scopedDir)) continue;
      try {
        const subEntries = readdirSync(scopedDir);
        for (const sub of subEntries) {
          checkExternalPkg(path.resolve(scopedDir, sub), results);
        }
      } catch {
        /* skip */
      }
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

    let specifier = oc.runtimeExtensions?.[0] || oc.extensions?.[0] || "./dist/index.js";
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
 */
export async function loadChannelPlugin(
  candidate: PluginCandidate,
): Promise<ChannelPluginObject | null> {
  if (loadedPlugins.has(candidate.id)) {
    return loadedPlugins.get(candidate.id)!;
  }

  try {
    const resolved = path.resolve(candidate.pkgRoot, candidate.entrySpecifier);
    const entryUrl = pathToFileURL(resolved).href;

    const entryModule = await import(entryUrl);
    const entry: ChannelEntry = entryModule.default ?? entryModule;

    if (!entry) {
      console.error(`[ocg] Plugin ${candidate.id}: no default export`);
      return null;
    }

    let plugin: ChannelPluginObject | null = null;

    // Both bundled and external plugins use a "register" convention.
    // Bundled plugins (defineBundledChannelEntry) return an object with:
    //   { register, setChannelRuntime, loadChannelPlugin, ... }
    // External plugins may export the register function directly as default.

    // If entry itself is a function, treat it as the register function.
    const entryIsRegisterFn = typeof entry === "function";

    const registerFn = entryIsRegisterFn
      ? (entry as (api: Record<string, unknown>) => void)
      : ((entry as Record<string, unknown>).register as
          | ((api: Record<string, unknown>) => void)
          | undefined);
    const setChannelRuntimeFn = entryIsRegisterFn
      ? undefined
      : ((entry as Record<string, unknown>).setChannelRuntime as
          | ((runtime: Record<string, unknown>) => void)
          | undefined);
    const loadChannelPluginFn = entryIsRegisterFn
      ? undefined
      : ((entry as Record<string, unknown>).loadChannelPlugin as
          | (() => Promise<ChannelPluginObject>)
          | undefined);

    // If the entry provides loadChannelPlugin, use it directly.
    // This is the preferred path for bundled plugins.
    if (typeof loadChannelPluginFn === "function") {
      try {
        plugin = await loadChannelPluginFn();
      } catch (err) {
        console.error(
          `[ocg] Plugin ${candidate.id}: loadChannelPlugin failed: ${(err as Error).message}`,
        );
        return null;
      }
    }

    // Fall back to the register convention (external or legacy plugins)
    if (!plugin && typeof registerFn === "function") {
      const captured: { plugin: ChannelPluginObject | null } = { plugin: null };
      const api: Record<string, unknown> = {
        registerChannel({ plugin: p }: { plugin: ChannelPluginObject }) {
          captured.plugin = p;
        },
        registerFull() {},
        registerCliMetadata() {},
        registerProvider() {},
        registerTool() {},
        registerGatewayMethod(_name: string, _handler: unknown) {
          // gateway methods (e.g. dingtalk's sendToUser, docs.read, etc.)
          // are registered but not invoked by the lite gateway.
        },
        runtime: { version: openclawVersion() },
        setChannelRuntime() {},
        logger: {
          info: (...args: unknown[]) => console.log(`[ocg:${candidate.id}]`, ...args),
          warn: (...args: unknown[]) => console.warn(`[ocg:${candidate.id}]`, ...args),
          error: (...args: unknown[]) => console.error(`[ocg:${candidate.id}]`, ...args),
          debug: (...args: unknown[]) => console.debug(`[ocg:${candidate.id}]`, ...args),
        },
      };
      registerFn(api);
      plugin = captured.plugin;
    }

    if (!plugin) {
      console.error(`[ocg] Plugin ${candidate.id}: could not extract ChannelPluginObject`);
      return null;
    }

    // Inject runtime BEFORE normalizing id (runtime must be set before plugin starts)
    if (typeof setChannelRuntimeFn === "function") {
      try {
        const shimDispatchUrl = pathToFileURL(
          path.resolve(__pluginDirname, "shims/reply-dispatch-runtime.js"),
        ).href;
        const { dispatchReplyWithBufferedBlockDispatcher } =
          await import(shimDispatchUrl);

        const { createPluginRuntime } = await import(
          pathToFileURL(path.resolve(__pluginDirname, "shims/runtime.js")).href
        );
        const runtime = createPluginRuntime(
          dispatchReplyWithBufferedBlockDispatcher as (
            ctx: Record<string, unknown>,
          ) => Promise<unknown>,
          openclawVersion(),
          candidate.id,
        );

        setChannelRuntimeFn(runtime);
        console.log(`[ocg] Injected runtime for ${candidate.id}`);
      } catch (err) {
        console.warn(
          `[ocg] Could not inject runtime for ${candidate.id}:`,
          (err as Error).message,
        );
      }
    }

    // Also try the legacy runtime injection path (non-bundled plugins)
    if (entry.runtime?.specifier) {
      const runtimeUrl = pathToFileURL(
        path.resolve(candidate.pkgRoot, entry.runtime.specifier),
      ).href;
      try {
        const runtimeModule = await import(runtimeUrl);
        const setRuntime = runtimeModule[entry.runtime.exportName] as
          | ((rt: Record<string, unknown>) => void)
          | undefined;
        if (typeof setRuntime === "function" && !setChannelRuntimeFn) {
          // Only use legacy path if setChannelRuntime wasn't already called
          const shimDispatchUrl = pathToFileURL(
            path.resolve(__pluginDirname, "shims/reply-dispatch-runtime.js"),
          ).href;
          const { dispatchReplyWithBufferedBlockDispatcher } =
            await import(shimDispatchUrl);

          const { createPluginRuntime } = await import(
            pathToFileURL(path.resolve(__pluginDirname, "shims/runtime.js")).href
          );
          const runtime = createPluginRuntime(
            dispatchReplyWithBufferedBlockDispatcher as (
              ctx: Record<string, unknown>,
            ) => Promise<unknown>,
            openclawVersion(),
            candidate.id,
          );
          setRuntime(runtime);
          console.log(`[ocg] Injected runtime (legacy) for ${candidate.id}`);
        }
      } catch (err) {
        console.warn(
          `[ocg] Could not inject runtime (legacy) for ${candidate.id}:`,
          (err as Error).message,
        );
      }
    }

    // Normalize id from plugin metadata
    if (!plugin.id && entry.id) plugin.id = entry.id;
    if (!plugin.id) plugin.id = candidate.id;

    loadedPlugins.set(candidate.id, plugin);

    const hasConfigAdapter =
      typeof plugin.config?.listAccountIds === "function" &&
      typeof plugin.config?.resolveAccount === "function";
    console.log(
      `[ocg] Loaded channel plugin: ${plugin.id} (${candidate.label}) — ` +
        `has startAccount: ${typeof plugin.gateway?.startAccount === "function"}, ` +
        `has configAdapter: ${hasConfigAdapter}`,
    );
    return plugin;
  } catch (err) {
    console.error(
      `[ocg] Failed to load plugin ${candidate.id}:`,
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

type RunningState = {
  stop: () => Promise<void>;
  abort: AbortController;
};

/** Key: "channelId:accountId" */
const runningChannels = new Map<string, RunningState>();

/**
 * Start a channel using the plugin's own config adapter.
 *
 * Calls plugin.config.listAccountIds(cfg) → for each account:
 *   resolveAccount(cfg, id) → isEnabled? / isConfigured? → startAccount(ctx)
 *
 * @param channelId - Channel identifier (e.g. "telegram")
 * @param cfg - Full config object matching OpenClaw shape
 */
export async function startChannel(
  channelId: string,
  cfg: Record<string, unknown>,
): Promise<string[]> {
  const plugin = loadedPlugins.get(channelId);
  if (!plugin) throw new Error(`Plugin "${channelId}" not loaded`);

  const startFn = plugin.gateway?.startAccount;
  if (!startFn) {
    throw new Error(`Plugin "${channelId}" has no gateway.startAccount`);
  }

  // Use the plugin's config adapter to enumerate and resolve accounts
  const configAdapter = plugin.config;
  const accountIds: string[] = configAdapter?.listAccountIds
    ? configAdapter.listAccountIds(cfg)
    : ["default"];

  console.log(`[ocg] ${channelId} accountIds from adapter:`, JSON.stringify(accountIds));

  const started: string[] = [];

  for (const accountId of accountIds) {
    const runKey = `${channelId}:${accountId}`;
    if (runningChannels.has(runKey)) {
      console.log(`[ocg] ${runKey} already running, skipping`);
      continue;
    }

    // Resolve the account via the plugin's adapter, or build a minimal one
    let account: ResolvedAccount;
    if (configAdapter?.resolveAccount) {
      account = configAdapter.resolveAccount(cfg, accountId);
    } else {
      // Fallback: build account from channel-level config
      const channelSection = (cfg.channels as Record<string, unknown>)?.[
        channelId
      ] as Record<string, unknown>;
      account = {
        accountId,
        enabled: channelSection?.enabled !== false,
        ...(channelSection ?? {}),
      };
    }

    console.log(`[ocg] ${runKey} resolved: enabled=${account.enabled}, appId=${(account as Record<string, unknown>).appId}, hasClientSecret=${Boolean((account as Record<string, unknown>).clientSecret)}`);

    // Check enabled
    if (configAdapter?.isEnabled) {
      if (!configAdapter.isEnabled(account, cfg)) {
        console.log(`[ocg] ${runKey} disabled, skipping`);
        continue;
      }
    } else if (account.enabled === false) {
      console.log(`[ocg] ${runKey} disabled (enabled=false), skipping`);
      continue;
    }

    // Check configured
    if (configAdapter?.isConfigured) {
      const configured = await configAdapter.isConfigured(account, cfg);
      if (!configured) {
        const reason = configAdapter.unconfiguredReason?.(account, cfg) ?? "not configured";
        console.log(`[ocg] ${runKey} not configured: ${reason}, skipping`);
        continue;
      }
      console.log(`[ocg] ${runKey} isConfigured=true, proceeding to start`);
    }

    const abort = new AbortController();

    // Build a full PluginRuntime with the dispatch surface so plugins
    // that require ctx.channelRuntime (e.g. openclaw-weixin) get it.
    const shimDispatchUrl = pathToFileURL(
      path.resolve(__pluginDirname, "shims/reply-dispatch-runtime.js"),
    ).href;
    const { dispatchReplyWithBufferedBlockDispatcher } =
      await import(shimDispatchUrl);
    const { createPluginRuntime } = await import(
      pathToFileURL(path.resolve(__pluginDirname, "shims/runtime.js")).href
    );
    const runtime = createPluginRuntime(
      dispatchReplyWithBufferedBlockDispatcher as (
        ctx: Record<string, unknown>,
      ) => Promise<unknown>,
      openclawVersion(),
      channelId,
    );

    const ctx: Record<string, unknown> = {
      cfg,
      channelId,
      accountId,
      account,
      runtime,
      channelRuntime: runtime.channel,
      abortSignal: abort.signal,
      log: {
        info: (...args: unknown[]) => console.log(`[${channelId}/${accountId}]`, ...args),
        warn: (...args: unknown[]) => console.warn(`[${channelId}/${accountId}]`, ...args),
        error: (...args: unknown[]) => console.error(`[${channelId}/${accountId}]`, ...args),
        debug: (...args: unknown[]) => console.debug(`[${channelId}/${accountId}]`, ...args),
      },
      getStatus: () => ({}),
      setStatus: (_next: unknown) => {},
    };

    // startAccount returns a Promise that resolves when the channel stops
    const task = startFn(ctx).catch((err: Error) => {
      console.error(`[ocg] ${runKey} crashed:`, err.message);
      runningChannels.delete(runKey);
    });

    runningChannels.set(runKey, {
      abort,
      stop: async () => {
        abort.abort();
        try {
          await plugin.gateway?.stopAccount?.(ctx);
        } catch {
          /* ignore */
        }
        try {
          await Promise.race([
            task.then(() => {}).catch(() => {}),
            new Promise<void>((r) => setTimeout(r, 5000)),
          ]);
        } catch {
          /* ignore */
        }
        runningChannels.delete(runKey);
      },
    });

    started.push(runKey);
    console.log(`[ocg] ${runKey} channel started`);
  }

  return started;
}

export async function stopChannel(channelId: string): Promise<void> {
  // Stop all account-scoped entries for this channel
  const toStop: string[] = [];
  for (const [key] of runningChannels) {
    if (key === channelId || key.startsWith(`${channelId}:`)) {
      toStop.push(key);
    }
  }

  if (toStop.length === 0) {
    console.log(`[ocg] ${channelId} not running`);
    return;
  }

  for (const key of toStop) {
    const entry = runningChannels.get(key);
    if (entry) {
      await entry.stop();
    }
  }
}

export function isChannelRunning(channelId: string): boolean {
  for (const key of runningChannels.keys()) {
    if (key === channelId || key.startsWith(`${channelId}:`)) return true;
  }
  return false;
}

export function listRunningChannels(): string[] {
  return [...new Set([...runningChannels.keys()].map((k) => k.split(":")[0]))];
}

export function listRunningAccounts(): Array<{ channelId: string; accountId: string }> {
  return [...runningChannels.keys()].map((k) => {
    const [channelId, ...rest] = k.split(":");
    return { channelId, accountId: rest.join(":") };
  });
}

export async function stopAllChannels(): Promise<void> {
  for (const key of runningChannels.keys()) {
    const entry = runningChannels.get(key);
    if (entry) {
      await entry.stop();
    }
  }
}

// ── Login / Logout ───────────────────────────────────────────────────────

/** Session storage for built-in auth flows (keyed by channel:account). */
const builtinAuthSessions = new Map<string, unknown>();

/**
 * Start a QR-based login flow for a channel that supports it.
 * Falls back to built-in auth handlers for channels that don't expose
 * loginWithQrStart themselves (e.g. dingtalk-connector).
 */
export async function channelLoginStart(
  channelId: string,
  params: Record<string, unknown> = {},
): Promise<{ qrDataUrl?: string; message?: string; sessionKey?: string }> {
  const plugin = loadedPlugins.get(channelId);
  if (!plugin) throw new Error(`Plugin "${channelId}" not loaded`);

  const loginFn = plugin.gateway?.loginWithQrStart;
  if (typeof loginFn === "function") {
    return (await loginFn(params)) as {
      qrDataUrl?: string;
      message?: string;
      sessionKey?: string;
    };
  }

  // ── Built-in fallback ──
  if (channelId === "dingtalk-connector") {
    const { dingtalkLoginStart } = await import(
      "./auth/dingtalk-login.js"
    );
    const result = await dingtalkLoginStart();
    const accountId = (params["accountId"] as string) ?? "default";
    const sessionKey = `${channelId}:${accountId}:${Date.now()}`;
    builtinAuthSessions.set(sessionKey, result.session);
    return {
      qrDataUrl: result.qrDataUrl,
      message: "Please scan the QR code with your DingTalk App",
      sessionKey,
    };
  }

  throw new Error(`Plugin "${channelId}" does not support QR login`);
}

/**
 * Wait for a QR login to complete.
 * Falls back to built-in auth handlers for channels that don't expose
 * loginWithQrWait themselves.
 */
export async function channelLoginWait(
  channelId: string,
  params: Record<string, unknown> = {},
): Promise<{ connected?: boolean; message?: string; accountId?: string; credentials?: Record<string, string> }> {
  const plugin = loadedPlugins.get(channelId);
  if (!plugin) throw new Error(`Plugin "${channelId}" not loaded`);

  const waitFn = plugin.gateway?.loginWithQrWait;
  if (typeof waitFn === "function") {
    const result = (await waitFn(params)) as {
      connected?: boolean;
      message?: string;
      accountId?: string;
    };
    return result;
  }

  // ── Built-in fallback ──
  if (channelId === "dingtalk-connector") {
    const sessionKey = (params["sessionKey"] as string) ?? "";
    const session = builtinAuthSessions.get(sessionKey);
    if (!session) {
      throw new Error("No active login session found for dingtalk-connector");
    }
    const { dingtalkLoginWait } = await import(
      "./auth/dingtalk-login.js"
    );
    const timeoutMs = (params["timeoutMs"] as number) ?? 120_000;
    try {
      const creds = await dingtalkLoginWait(
        session as import("./auth/dingtalk-login.js").DeviceAuthSession,
        undefined,
        timeoutMs,
      );
      return {
        connected: true,
        message: "DingTalk login successful",
        accountId: (params["accountId"] as string) ?? "default",
        credentials: { clientId: creds.clientId, clientSecret: creds.clientSecret },
      };
    } catch (err) {
      return {
        connected: false,
        message: (err as Error).message,
      };
    } finally {
      builtinAuthSessions.delete(sessionKey);
    }
  }

  throw new Error(`Plugin "${channelId}" does not support QR login wait`);
}

/**
 * Logout an account from a channel.
 */
export async function channelLogout(
  channelId: string,
  accountId?: string,
  cfg?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const plugin = loadedPlugins.get(channelId);
  if (!plugin) throw new Error(`Plugin "${channelId}" not loaded`);

  const logoutFn = plugin.gateway?.logoutAccount;
  if (!logoutFn) {
    throw new Error(`Plugin "${channelId}" does not support logout`);
  }

  return await logoutFn({
    cfg: cfg ?? {},
    accountId: accountId ?? "default",
    runtime: { version: openclawVersion() },
    abortSignal: new AbortController().signal,
    log: {
      info: (...args: unknown[]) => console.log(`[${channelId}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[${channelId}]`, ...args),
      error: (...args: unknown[]) => console.error(`[${channelId}]`, ...args),
      debug: (...args: unknown[]) => console.debug(`[${channelId}]`, ...args),
    },
  });
}
