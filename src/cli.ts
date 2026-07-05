/**
 * Lite Gateway CLI — mirrors `openclaw channels` command surface.
 *
 * Usage:
 *   ocg start                     启动全部
 *   ocg stop                      停止全部
 *   ocg restart                   重启全部
 *   ocg status                    网关状态
 *   ocg version                   版本
 *   ocg upgrade                   升级 OCG CLI
 *
 *   ocg channels list [--json]    列出 channels
 *   ocg channels status [--channel <name>] [--json]
 *   ocg channels start --channel <name>
 *   ocg channels stop --channel <name>
 *   ocg channels restart --channel <name>
 *   ocg channels add --channel <name> [--token <token>] [--<key> <value> ...]
 *   ocg channels remove --channel <name>
 */

import {
  startGateway,
  stopGateway,
  gatewayStatus,
  loadConfig,
  buildOpenClawConfig,
  addChannel,
  removeChannel,
  getChannelSection,
  listConfiguredChannels,
  listAllChannels,
  resolveConfigPath,
  resolveConfigDir,
  saveConfig,
} from "./index.js";
import { applyConfigEnvOverrides } from "./config.js";
import { startCallbackServer, isCallbackServerRunning } from "./callback-server.js";
import {
  startChannel,
  stopChannel,
  restartChannel,
  getChannelStatus,
  ensurePluginsLoaded,
} from "./gateway.js";
import {
  listLoadedPlugins,
  loadChannelPlugin,
  discoverBundledPlugins,
  discoverExternalPlugins,
  channelLoginStart,
  channelLoginWait,
} from "./plugin-loader.js";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readPackageVersion();

// ── Helpers ───────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log(
    "╔══════════════════════════════════════╗\n" +
    `║         OCG  v${VERSION.padEnd(24)}║\n` +
    "║   OpenClaw Channel Gateway            ║\n" +
    "║   IM bridge → External Agent API      ║\n" +
    "╚══════════════════════════════════════╝",
  );
}

function printHelp(): void {
  printBanner();
  console.log("");
  console.log("Usage: ocg <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  start [--log-file] [--log-dir <dir>]  Start all enabled channels");
  console.log("  stop                          Stop all channels");
  console.log("  restart                       Restart all channels");
  console.log("  status                        Show gateway status");
  console.log("  test                          Run dispatch smoke test");
  console.log("  version                       Print version");
  console.log("  upgrade [--package-manager <pm>] [--target <version>] [--local] [--dry-run]");
  console.log("                                Upgrade OCG CLI (default: npm global latest)");
  console.log("");
  console.log("  channels list [--all] [--json]  List channels");
  console.log("  channels status [--channel] [--json]  Show channel status");
  console.log("  channels start --channel <id>    Start a channel");
  console.log("  channels stop --channel <id>     Stop a channel");
  console.log("  channels restart --channel <id>  Restart a channel");
  console.log("  channels login --channel <id>    QR login (for WeChat, etc.)");
  console.log("  channels add --channel <id> [--account <id>] [--<k> <v> ...]  Add a channel account");
  console.log("  channels remove --channel <id>   Remove a channel");
  console.log("");
  console.log("  plugins install <pkg>            Install a channel plugin (npm install)");
  console.log("  plugins list                     List installed channel plugins");
  console.log("");
  console.log("  config set <path> <value>        Set config value (OpenClaw-compatible paths)");
  console.log("  config get [path]                Print config or config value");
  console.log("");
  console.log("Environment:");
  console.log("  OCG_CONFIG_PATH     Config file path");
  console.log("  OCG_AGENT_URL       Agent API URL");
  console.log("  OCG_MODEL           Model name");
  console.log("  OCG_API_KEY         API key");
  console.log("  OCG_TELEGRAM_TOKEN  Telegram bot token");
}

// ── Arg parser (simple positional + flags, no Commander dependency) ────────

type Args = Record<string, string | boolean>;

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function parseArgs(raw: string[]): { command: string; args: Args } {
  const positional: string[] = [];
  const flags: Args = {};

  for (let i = 2; i < raw.length; i++) {
    const a = raw[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = raw[i + 1];
        if (next && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else if (a.startsWith("-") && a.length === 2 && a !== "--") {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }

  return { command: positional.join(" "), args: flags };
}

// ── Handlers ──────────────────────────────────────────────────────────────

async function cmdTest(): Promise<void> {
  const { createServer } = await import("node:http");

  console.log("[ocg] Running dispatch test...\n");

  const body = JSON.stringify({
    id: "test-1",
    object: "chat.completion.chunk",
    choices: [
      { index: 0, delta: { content: "Hello" }, finish_reason: null },
      { index: 0, delta: { content: " from" }, finish_reason: null },
      { index: 0, delta: { content: " lite" }, finish_reason: null },
      { index: 0, delta: { content: " gateway!" }, finish_reason: "stop" },
    ],
  });

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunks = JSON.parse(body).choices as Array<Record<string, unknown>>;
    let i = 0;
    const timer = setInterval(() => {
      if (i >= chunks.length) {
        res.end("data: [DONE]\n\n");
        clearInterval(timer);
        server.close();
        return;
      }
      res.write(`data: ${JSON.stringify({ ...JSON.parse(body), choices: [chunks[i]] })}\n\n`);
      i++;
    }, 10);
  });

  const port = 50000 + Math.floor(Math.random() * 15000);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`[mock-agent] Listening on http://127.0.0.1:${port}\n`);

  process.env.OCG_AGENT_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.OCG_MODEL = "gpt-4o";
  process.env.OCG_API_KEY = "test-key";

  const { dispatchReplyWithBufferedBlockDispatcher } =
    await import("./shims/reply-dispatch-runtime.js");

  console.log("─── Testing dispatchReplyWithBufferedBlockDispatcher ───\n");

  const collectedTexts: string[] = [];
  let finalText = "";

  const result = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: {
      Body: "Hello!",
      BodyForAgent: "Hello!",
      From: "telegram:12345",
      SessionKey: "telegram:default:12345",
    },
    cfg: {},
    dispatcherOptions: {
      deliver: async (payload: Record<string, unknown>, meta: { kind: string }) => {
        if (meta.kind === "block") collectedTexts.push(payload.text as string);
        else if (meta.kind === "final") finalText = payload.text as string;
      },
    },
  });

  console.log("─── Results ───\n");
  console.log(`Model selected: ${process.env.OCG_MODEL}`);
  console.log(`Collected blocks:`, collectedTexts);
  console.log(`Final text: ${finalText}`);
  console.log(`Result counts:`, result.counts);
  console.log(`Queued final:`, result.queuedFinal);

  console.log("\n─── Checks ───\n");
  const counts = result.counts as Record<string, number> | undefined;
  const checks = [
    ["modelSelected === \"gpt-4o\"", process.env.OCG_MODEL === "gpt-4o"],
    ["collectedTexts.length === 4", collectedTexts.length === 4],
    ["finalText === \"Hello from lite gateway!\"", finalText === "Hello from lite gateway!"],
    ["result.counts.block === 4", counts?.block === 4],
    ["result.counts.final === 1", counts?.final === 1],
    ["result.queuedFinal === true", result.queuedFinal === true],
  ];

  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${label}: ${ok}`);
    if (!ok) allOk = false;
  }

  console.log(allOk ? "\n✅ All tests passed!" : "\n❌ Some tests failed!");
  if (!allOk) process.exit(1);
}

function shouldWriteStartLogsToFile(args: Args): boolean {
  return args["log-file"] === true || args["log"] === true || typeof args["log-dir"] === "string";
}

function resolveStartLogDir(args: Args): string {
  const logDir = args["log-dir"];
  if (typeof logDir === "string" && logDir.trim()) return resolve(logDir);
  return join(resolveConfigDir(), "ocg.logs");
}

function formatLogLine(level: "log" | "error" | "warn", values: unknown[]): string {
  const text = values.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ");
  return `${new Date().toISOString()} [${level}] ${text}\n`;
}

async function runWithConsoleLogFile(logDir: string, fn: () => Promise<void>): Promise<void> {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `ocg-start-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const writeLog = (level: "log" | "error" | "warn", values: unknown[]) => {
    appendFileSync(logPath, formatLogLine(level, values), "utf8");
  };
  const writeRaw = (chunk: string | Uint8Array, encoding?: BufferEncoding) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding ?? "utf8");
    appendFileSync(logPath, text, "utf8");
  };
  let caught: unknown;

  console.log = (...values: unknown[]) => { writeLog("log", values); };
  console.error = (...values: unknown[]) => { writeLog("error", values); };
  console.warn = (...values: unknown[]) => { writeLog("warn", values); };
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error) => void), callback?: (err?: Error) => void) => {
    writeRaw(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined);
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error) => void), callback?: (err?: Error) => void) => {
    writeRaw(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined);
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (cb) cb();
    return true;
  }) as typeof process.stderr.write;

  originalLog(`[ocg] Writing start logs to ${logPath}`);

  try {
    await fn();
  } catch (err) {
    caught = err;
    console.error("Error:", (err as Error).message);
  }

  if (caught) {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
    process.exit(1);
  }
}

async function cmdStart(args: Args = {}): Promise<void> {
  if (shouldWriteStartLogsToFile(args)) {
    await runWithConsoleLogFile(resolveStartLogDir(args), startGateway);
    return;
  }

  try {
    await startGateway();
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

async function cmdStop(): Promise<void> {
  await stopGateway();
  console.log("[ocg] Stopped");
}

async function cmdRestart(): Promise<void> {
  await stopGateway();
  await cmdStart();
}

function cmdStatus(args: Args = {}): void {
  const s = gatewayStatus();
  if (args["json"]) {
    console.log(JSON.stringify(s, null, 2));
  } else {
    console.log(`Agent:  ${s.agentUrl}`);
    console.log(`Model:  ${s.model}`);
    console.log(`Channels configured: ${s.configured}, running: ${s.running}`);
    const channels = s.channels as Array<Record<string, unknown>>;
    for (const c of channels) {
      const uptime = typeof c.uptime === "number" ? `${c.uptime}s` : "—";
      const chAgentUrl = c.agentUrl as string | undefined;
      const agentInfo = chAgentUrl && chAgentUrl !== s.agentUrl
        ? `  agent: ${chAgentUrl}`
        : "";
      console.log(`  ${c.id}  ${c.status}  uptime: ${uptime}${agentInfo}`);
    }
  }
}

async function cmdChannelsList(args: Args): Promise<void> {
  const all = args["all"];
  const ids = all ? listAllChannels() : listConfiguredChannels();
  if (args["json"]) {
    console.log(JSON.stringify(ids, null, 2));
  } else {
    if (ids.length === 0) {
      if (args["all"]) {
        console.log("No channels in config. Use: ocg channels add --channel <id> [--<key> <value> ...]");
      } else {
        console.log("No enabled channels. Use --all to show disabled channels.");
      }
    } else {
      for (const id of ids) console.log(id);
    }
  }
}

async function cmdChannelsStatus(args: Args): Promise<void> {
  const channelId = args["channel"] as string | undefined;
  if (channelId) {
    const entry = getChannelStatus(channelId);
    if (args["json"]) {
      console.log(JSON.stringify(entry ?? { status: "not-found" }, null, 2));
    } else if (entry) {
      console.log(`${entry.channelId}: ${entry.status} (uptime: ${Math.round((Date.now() - entry.startedAt) / 1000)}s)`);
    } else {
      console.log(`${channelId}: not running`);
    }
  } else {
    cmdStatus(args);
  }
}

async function cmdChannelsStart(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  if (!channelId) {
    console.error("Missing --channel <id>");
    process.exit(1);
  }
  await ensurePluginsLoaded();
  const rawCfg = loadConfig();
  if (!rawCfg) {
    console.error("No config found. Create ocg.json");
    process.exit(1);
  }
  applyConfigEnvOverrides(rawCfg);

  // Start callback server for async dispatch (only if not already running)
  if (!isCallbackServerRunning()) {
    const cbHost = rawCfg.callbackHost ?? "0.0.0.0";
    const cbPort = rawCfg.callbackPort ?? 3457;
    try {
      await startCallbackServer(cbHost, cbPort, rawCfg.callbackSecret);
    } catch (err) {
      console.error(`[ocg] Failed to start callback server: ${(err as Error).message}`);
    }
  }

  const cfg = buildOpenClawConfig(rawCfg);
  const chCfg = getChannelSection(channelId);
  if (!chCfg) {
    console.error(`Channel "${channelId}" not found in config`);
    process.exit(1);
  }
  const started = await startChannel(channelId, cfg);
  if (started.length === 0) {
    console.log(`[ocg] ${channelId}: no enabled/configured accounts to start`);
  } else {
    for (const key of started) console.log(`[ocg] ${key} started`);
  }
}

async function cmdChannelsStop(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  if (!channelId) {
    console.error("Missing --channel <id>");
    process.exit(1);
  }
  await stopChannel(channelId);
  console.log(`[ocg] ${channelId} stopped`);
}

async function cmdChannelsRestart(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  if (!channelId) {
    console.error("Missing --channel <id>");
    process.exit(1);
  }
  await ensurePluginsLoaded();
  const rawCfg = loadConfig();
  if (!rawCfg) {
    console.error("No config found.");
    process.exit(1);
  }
  applyConfigEnvOverrides(rawCfg);
  const cfg = buildOpenClawConfig(rawCfg);
  const chCfg = getChannelSection(channelId);
  if (!chCfg) {
    console.error(`Channel "${channelId}" not found in config`);
    process.exit(1);
  }
  const started = await restartChannel(channelId, cfg);
  if (started.length === 0) {
    console.log(`[ocg] ${channelId}: no enabled/configured accounts`);
  } else {
    for (const key of started) console.log(`[ocg] ${key} restarted`);
  }
}

async function cmdChannelsAdd(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  const accountId = (args["account"] as string) ?? "default";

  if (!channelId) {
    console.error(
      "Usage: ocg channels add --channel <id> [--account <id>] [--<key> <value> ...]",
    );
    console.error("Examples:");
    console.error('  ocg channels add --channel telegram --botToken "123:abc"');
    console.error('  ocg channels add --channel qqbot --token "AppID:AppSecret"');
    console.error('  ocg channels add --channel discord --token "..." --account ops');
    process.exit(1);
  }
  // Collect plugin-specific fields (everything except channel and account)
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k !== "channel" && k !== "account") fields[k] = v;
  }

  // Parse qqbot token format: "AppID:AppSecret" → appId + clientSecret
  if (channelId === "qqbot" && typeof fields.token === "string") {
    const colon = fields.token.indexOf(":");
    if (colon > 0) {
      fields.appId = fields.token.slice(0, colon);
      fields.clientSecret = fields.token.slice(colon + 1);
      delete fields.token;
    }
  }

  addChannel(channelId, accountId, fields);
  console.log(`[ocg] Channel "${channelId}" account "${accountId}" added`);
}

async function cmdChannelsRemove(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  if (!channelId) {
    console.error("Missing --channel <id>");
    process.exit(1);
  }
  removeChannel(channelId);
  console.log(`[ocg] Channel "${channelId}" removed`);
}

async function cmdChannelsLogin(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  if (!channelId) {
    console.error("Usage: ocg channels login --channel <id>");
    console.error("Example: ocg channels login --channel openclaw-weixin");
    process.exit(1);
  }
  await ensurePluginsLoaded();
  const rawCfg = loadConfig() ?? {};
  const cfg = buildOpenClawConfig(rawCfg);

  // Ensure the channel is in config (at least as a placeholder)
  const chCfg = getChannelSection(channelId);
  if (!chCfg) {
    console.error(`Channel "${channelId}" not found in config. Add it first:`);
    console.error(`  ocg channels add --channel ${channelId}`);
    process.exit(1);
  }

  console.log(`[ocg] Starting QR login for ${channelId}...`);

  // Step 1: Start QR login
  const startResult = await channelLoginStart(channelId, {
    cfg,
    accountId: args["account"] ?? "default",
    force: args["force"] ?? false,
    verbose: args["verbose"] ?? false,
  });

  console.log(`[ocg] ${startResult.message ?? "Ready"}`);
  if (startResult.qrDataUrl) {
    // Render QR code directly in the terminal
    try {
      const qrcodeMod = await import("qrcode-terminal");
      const qrcode = (qrcodeMod as any).default ?? qrcodeMod;
      console.log("");
      await new Promise<void>((resolve) => {
        qrcode.generate(
          startResult.qrDataUrl!,
          { small: true },
          (output: string) => {
            console.log(output);
            resolve();
          },
        );
      });
      const scanHint =
        channelId === "dingtalk-connector"
          ? "📱 Scan the QR code with DingTalk on your phone"
          : "📱 Scan the QR code with WeChat on your phone";
      console.log(`  ${scanHint}`);
      console.log(`  🔗 ${startResult.qrDataUrl}\n`);
    } catch {
      // Fallback: open in browser
      console.log(`\n  🔳  QR Code: ${startResult.qrDataUrl}\n`);
      try {
        const { exec } = await import("node:child_process");
        const url = startResult.qrDataUrl!;
        const plat = process.platform;
        exec(plat === "win32" ? `start "" "${url}"` : plat === "darwin" ? `open "${url}"` : `xdg-open "${url}"`);
      } catch { /* ignore */ }
    }
  }

  // Step 2: Wait for scan
  console.log(`[ocg] Waiting for QR scan (timeout: 120s)...`);
  const waitResult = await channelLoginWait(channelId, {
    cfg,
    sessionKey: startResult.sessionKey ?? "",
    accountId: args["account"] ?? "default",
    timeoutMs: 120_000,
  });

  if (waitResult.connected) {
    const accountId = (args["account"] as string) ?? "default";
    console.log(`[ocg] Login successful! Account: ${waitResult.accountId ?? accountId}`);

    // If the login flow returned credentials (built-in auth handlers), save them
    if (waitResult.credentials) {
      addChannel(channelId, accountId, waitResult.credentials as Record<string, unknown>);
      console.log(`[ocg] Credentials saved to config`);
    }

    console.log(`[ocg] Now start the channel: ocg channels start --channel ${channelId}`);
  } else {
    console.error(`[ocg] Login failed: ${waitResult.message ?? "timeout or cancelled"}`);
    process.exit(1);
  }
}

// ── Upgrade ──────────────────────────────────────────────────────────────

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

function resolveExecutable(command: string): string {
  if (process.platform !== "win32") return command;
  if (command === "npm" || command === "pnpm" || command === "yarn") return `${command}.cmd`;
  return command;
}

function runPackageManagerCommand(command: string, args: string[], cwd: string): void {
  execFileSync(resolveExecutable(command), args, { cwd, stdio: "inherit" });
}

function resolvePackageManager(args: Args): PackageManager {
  const raw = (args["package-manager"] ?? args["pm"]) as string | boolean | undefined;
  if (!raw || raw === true) return "npm";
  if (["npm", "pnpm", "yarn", "bun"].includes(raw)) return raw as PackageManager;
  console.error(`Unsupported package manager: ${raw}`);
  console.error("Supported package managers: npm, pnpm, yarn, bun");
  process.exit(1);
}

function buildUpgradeCommand(pm: PackageManager, target: string, global: boolean): { command: string; args: string[] } {
  if (global) {
    switch (pm) {
      case "npm": return { command: "npm", args: ["install", "-g", `openclaw-channel-gateway@${target}`] };
      case "pnpm": return { command: "pnpm", args: ["add", "-g", `openclaw-channel-gateway@${target}`] };
      case "yarn": return { command: "yarn", args: ["global", "add", `openclaw-channel-gateway@${target}`] };
      case "bun": return { command: "bun", args: ["add", "-g", `openclaw-channel-gateway@${target}`] };
    }
  }

  switch (pm) {
    case "npm": return { command: "npm", args: ["install", `openclaw-channel-gateway@${target}`] };
    case "pnpm": return { command: "pnpm", args: ["add", `openclaw-channel-gateway@${target}`] };
    case "yarn": return { command: "yarn", args: ["add", `openclaw-channel-gateway@${target}`] };
    case "bun": return { command: "bun", args: ["add", `openclaw-channel-gateway@${target}`] };
  }
}

async function cmdUpgrade(args: Args): Promise<void> {
  const pm = resolvePackageManager(args);
  const target = resolveUpgradeTarget(args);
  const global = args["global"] === true || args["g"] === true || args["local"] !== true;
  const dryRun = args["dry-run"] === true;
  const upgrade = buildUpgradeCommand(pm, target, global);
  const printable = [upgrade.command, ...upgrade.args.map(quoteShellArg)].join(" ");

  console.log(`[ocg] Current version: ${VERSION}`);
  console.log(`[ocg] Upgrade command: ${printable}`);
  if (dryRun) return;

  try {
    runPackageManagerCommand(upgrade.command, upgrade.args, process.cwd());
    console.log(`[ocg] Upgrade complete. Restart your shell if the old ocg is still cached.`);
  } catch (err) {
    console.error(`[ocg] Upgrade failed: ${(err as Error).message}`);
    console.error(`[ocg] You can run it manually: ${printable}`);
    process.exit(1);
  }
}

function resolveUpgradeTarget(args: Args): string {
  if (typeof args["target"] === "string") return args["target"];
  if (typeof args["to"] === "string") return args["to"];
  return "latest";
}

// ── Plugins ──────────────────────────────────────────────────────────────

async function cmdPluginsInstall(pkg: string): Promise<void> {
  if (!pkg) {
    console.error("Usage: ocg plugins install <package>");
    console.error("Example: ocg plugins install @openclaw/qqbot");
    process.exit(1);
  }
  console.log(`[ocg] Installing ${pkg}...`);
  const { execSync } = await import("node:child_process");
  const cwd = process.cwd();
  try {
    execSync(`npm install ${pkg}`, { cwd, stdio: "inherit" });
    console.log(`[ocg] ${pkg} installed.`);
  } catch {
    console.error(`[ocg] Failed to install ${pkg}`);
    process.exit(1);
  }

  // Try to discover and load the newly installed plugin
  const external = discoverExternalPlugins();
  const newPlugin = external.find((p) => pkg.includes(p.id));
  if (newPlugin) {
    const loaded = await loadChannelPlugin(newPlugin);
    if (loaded) {
      console.log(
        `[ocg] Plugin "${newPlugin.id}" ready. ` +
          `Example: ocg channels add --channel ${newPlugin.id} --<key> <value>`,
      );
    } else {
      console.log(
        `[ocg] Plugin "${newPlugin.id}" found but could not be loaded. Check compatibility.`,
      );
    }
  } else {
    console.log(
      `[ocg] Installed but no channel metadata found for ${pkg}. ` +
        `Check the package has "openclaw.channel" in package.json.`,
    );
  }
}

function parseConfigValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to string for non-JSON shell input.
    }
  }
  return value;
}

function splitConfigPath(path: string): string[] {
  return path.split(".").filter(Boolean);
}

function getConfigPathValue(root: Record<string, unknown>, path: string): unknown {
  const parts = splitConfigPath(path);
  let cursor: unknown = root;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function setConfigPathValue(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = splitConfigPath(path);
  if (parts.length === 0) throw new Error("Config path cannot be empty");

  let cursor: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function syncPluginEnablePathToChannel(
  cfg: Record<string, unknown>,
  path: string,
  value: unknown,
): string | null {
  const match = /^plugins\.entries\.([^.]+)\.enabled$/.exec(path);
  if (!match) return null;

  const channelId = match[1];
  const channels = (cfg.channels ??= {}) as Record<string, unknown>;
  const existing = channels[channelId];
  const channel =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  channel.enabled = value;
  channels[channelId] = channel;
  return channelId;
}

function cmdConfigSet(path: string, rawValue: string | undefined): void {
  if (!path || rawValue === undefined) {
    console.error("Usage: ocg config set <path> <value>");
    console.error("Example: ocg config set plugins.entries.openclaw-weixin.enabled true");
    process.exit(1);
  }

  const cfg = (loadConfig() ?? {}) as Record<string, unknown>;
  const value = parseConfigValue(rawValue);
  setConfigPathValue(cfg, path, value);
  const syncedChannel = syncPluginEnablePathToChannel(cfg, path, value);
  saveConfig(cfg);

  console.log(`[ocg] Set ${path} = ${JSON.stringify(value)}`);
  if (syncedChannel) {
    console.log(`[ocg] Synced channel "${syncedChannel}" enabled = ${JSON.stringify(value)}`);
  }
}

function cmdConfigGet(path?: string): void {
  const cfg = (loadConfig() ?? {}) as Record<string, unknown>;
  const value = path ? getConfigPathValue(cfg, path) : cfg;
  if (value === undefined) {
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function cmdPluginsList(): Promise<void> {
  // Show discovered plugins (both bundled and external)
  const bundled = discoverBundledPlugins();
  const external = discoverExternalPlugins();
  const loaded = listLoadedPlugins();

  console.log("Bundled plugins (shipped with openclaw):");
  if (bundled.length === 0) {
    console.log("  (none found)");
  } else {
    for (const p of bundled) {
      const status = loaded.includes(p.id) ? "loaded" : "available";
      console.log(`  ${p.id}  [${status}]  ${p.label}`);
    }
  }

  console.log("");
  console.log("External plugins (installed via npm):");
  if (external.length === 0) {
    console.log("  (none found)");
    console.log("  Install: ocg plugins install @openclaw/qqbot");
  } else {
    for (const p of external) {
      const status = loaded.includes(p.id) ? "loaded" : "available";
      console.log(`  ${p.id}  [${status}]  ${p.label}`);
    }
  }

  console.log("");
  console.log("To add a channel: ocg channels add --channel <id> [--account <id>] [--<key> <value> ...]");
}

// ── Main dispatch ─────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const { command, args } = parseArgs(process.argv);

  // Flags-only invocations: --help, --version before positional dispatch
  if (args["help"] || args["h"]) return printHelp();
  if (args["version"] || args["v"]) {
    console.log(`ocg v${VERSION}`);
    return;
  }

  // Top-level commands
  if (!command || command === "help") return printHelp();
  if (command === "start") return cmdStart(args);
  if (command === "version") { console.log(`ocg v${VERSION}`); return; }

  switch (command) {
    case "stop": return cmdStop();
    case "restart": return cmdRestart();
    case "status": return cmdStatus(args);
    case "test": return cmdTest();
    case "upgrade": return cmdUpgrade(args);
  }

  // plugins subcommands
  if (command.startsWith("plugins ")) {
    const rest = command.slice("plugins ".length);
    if (rest === "list") return cmdPluginsList();
    if (rest.startsWith("install ")) {
      const pkg = rest.slice("install ".length);
      return cmdPluginsInstall(pkg);
    }
    if (rest === "install") {
      console.error("Usage: ocg plugins install <package>");
      process.exit(1);
    }
    console.log("Usage: ocg plugins <install|list>");
    process.exit(1);
  }

  // config subcommands
  if (command.startsWith("config ")) {
    const rest = command.slice("config ".length);
    if (rest.startsWith("set ")) {
      const tokens = rest.slice("set ".length).trim().split(/\s+/);
      const path = tokens.shift() ?? "";
      return cmdConfigSet(path, tokens.join(" "));
    }
    if (rest === "get") return cmdConfigGet();
    if (rest.startsWith("get ")) return cmdConfigGet(rest.slice("get ".length).trim());
    console.log("Usage: ocg config <set|get>");
    console.log("  ocg config set plugins.entries.openclaw-weixin.enabled true");
    console.log("  ocg config get plugins.entries.openclaw-weixin.enabled");
    process.exit(1);
  }

  // channels subcommands
  if (command.startsWith("channels ")) {
    const sub = command.slice("channels ".length);
    switch (sub) {
      case "list": return cmdChannelsList(args);
      case "status": return cmdChannelsStatus(args);
      case "start": return cmdChannelsStart(args);
      case "stop": return cmdChannelsStop(args);
      case "restart": return cmdChannelsRestart(args);
      case "add": return cmdChannelsAdd(args);
      case "remove": return cmdChannelsRemove(args);
      case "login": return cmdChannelsLogin(args);
      default:
        // `ocg channels` with no subcommand
        console.log("Usage: ocg channels <subcommand>");
        console.log("  list, status, start, stop, restart, add, remove");
        console.log("  ocg channels --help  for details");
        process.exit(1);
    }
  }

  // Unknown
  if (command === "config") {
    console.log("Usage: ocg config <set|get>");
    console.log("  ocg config set plugins.entries.openclaw-weixin.enabled true");
    console.log("  ocg config get plugins.entries.openclaw-weixin.enabled");
    process.exit(1);
  }

  console.error(`Unknown command: ${command}`);
  console.error("Use ocg --help");
  process.exit(1);
}

run().catch((err) => {
  console.error("[ocg] Fatal:", (err as Error).message);
  process.exit(1);
});
