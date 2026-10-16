/**
 * Lite Gateway CLI — mirrors `openclaw channels` command surface.
 *
 * Usage:
 *   ocg start                     启动全部
 *   ocg stop                      停止全部
 *   ocg restart                   重启全部
 *   ocg status                    网关状态
 *   ocg chat <message>            从终端发送消息走 HTTP/ACP dispatch
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
  saveConfig,
} from "./index.js";
import { applyConfigEnvOverrides, isMailboxConfigured, resolveSendSettings } from "./config.js";
import { executeSend } from "./send-service.js";
import { startCallbackServer, isCallbackServerRunning } from "./callback-server.js";
import { ensureLocalToken, resolveLocalTokenPath } from "./local-auth.js";
import {
  DEFAULT_DAEMON_HOST,
  daemonRequest,
  probeDaemonHealth,
  resolveDaemonEndpoint,
  type DaemonResponse,
} from "./daemon-client.js";
import {
  followLogFile,
  latestLogFile,
  readLastLines,
  resolveDaemonLogDir,
  stopDaemonProcess,
} from "./daemon-control.js";
import { buildSkillMarkdown } from "./skill-template.js";
import {
  clearGatewayProcessState,
  isProcessRunning,
  readGatewayProcessState,
} from "./process-state.js";
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
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { homedir } from "node:os";
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
  console.log("  start [--background|-d] [--log-file] [--log-dir <dir>]  Start all enabled channels");
  console.log("  stop                          Stop the gateway (background daemon included)");
  console.log("  restart                       Restart the gateway");
  console.log("  status                        Show gateway status (merges daemon health)");
  console.log("  chat [message] [--interactive|-i]  Send terminal input through HTTP/ACP dispatch");
  console.log("                                Options: --channel <id>, --agent-type <http|acp>, --agent-url <url>, --acp-command <cmd>");
  console.log("  send --channel <id> --to <target> --text <text>");
  console.log("       [--account <id>] [--media-url <url>] [--reply-to <messageId>] [--chunk-prefix] [--json]");
  console.log("                                Proactively send a message to a channel target");
  console.log("");
  console.log("  daemon start [--log-dir <dir>] [--timeout <sec>] [--json]  Start the background daemon (polls health)");
  console.log("  daemon stop [--timeout <sec>] [--json]      Stop the background daemon");
  console.log("  daemon status [--json]                      Daemon health / channels / mailbox");
  console.log("  daemon logs [--tail <n>] [--follow]         Show the newest daemon log");
  console.log("");
  console.log("  inbox wait [--timeout <sec>] [--channel <id>] [--consumer <name>] [--max <n>] [--peek] [--json]");
  console.log("                                Pull queued messages (agentType: \"mailbox\")");
  console.log("  inbox list [--state pending|leased|done|all] [--limit <n>] [--channel <id>] [--json]");
  console.log("  inbox show <id> [--json]                    Full message detail (incl. media paths)");
  console.log("  inbox ack <id> [--force] [--consumer <name>]  Finish without replying");
  console.log("  reply <id> (--text <t> | --text-file <f> | -) [--media <url>] [--error] [--json]");
  console.log("                                Reply to a pulled message ('-' reads stdin)");
  console.log("  targets list [--channel <id>] [--json]      Recently seen send targets");
  console.log("");
  console.log("  doctor [--json]               Diagnose config, daemon, token, channels");
  console.log("  skill install|show [--dir <path>] [--force]  Install/print the agent SKILL.md");
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
  console.log("  OCG_AGENT_TYPE      Agent transport: http, acp or mailbox");
  console.log("  OCG_AGENT_URL       Agent API URL (HTTP mode)");
  console.log("  OCG_ACP_COMMAND     ACP binary (ACP mode)");
  console.log("  OCG_ACP_ARGS        ACP args as JSON array (ACP mode)");
  console.log("  OCG_ACP_CWD         ACP working directory (ACP mode)");
  console.log("  OCG_MODEL           Model name");
  console.log("  OCG_API_KEY         API key");
  console.log("  OCG_TELEGRAM_TOKEN  Telegram bot token");
  console.log("  OCG_CONSUMER        Default inbox consumer name (default \"default\")");
  console.log("  OCG_DAEMON_URL      Override daemon endpoint discovery");
  console.log("  OCG_AUTO_START      =1 lets inbox/reply auto-start the daemon");
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

  const first = positional[0];
  if (first === "chat") {
    return { command: positional.length > 1 ? `chat ${positional.slice(1).join(" ")}` : "chat", args: flags };
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
  return resolveDaemonLogDir();
}

function shouldStartInBackground(args: Args): boolean {
  return args["background"] === true || args["bg"] === true || args["daemon"] === true || args.d === true;
}

function createStartLogPath(logDir: string): string {
  mkdirSync(logDir, { recursive: true });
  return join(logDir, `ocg-start-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
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
  const logPath = createStartLogPath(logDir);
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

function buildBackgroundStartArgs(args: Args): string[] {
  const childArgs = process.argv.slice(2).filter((arg) => !["--background", "--bg", "--daemon", "-d"].includes(arg));
  if (!shouldWriteStartLogsToFile(args)) childArgs.push("--log-file");
  return childArgs;
}

function startGatewayInBackground(args: Args): void {
  const logPath = createStartLogPath(resolveStartLogDir(args));
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...buildBackgroundStartArgs(args)], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: ["ignore", out, err],
  });

  child.unref();
  closeSync(out);
  closeSync(err);

  console.log(`[ocg] Started in background (pid: ${child.pid})`);
  console.log(`[ocg] Logs: ${logPath}`);
}

/**
 * Spawn a detached daemon ("start --log-file", optional --log-dir).
 * Used by `ocg daemon start`; the args list is built explicitly so the child
 * never sees the `daemon start` command itself (which would recurse).
 */
function spawnDaemonProcess(args: Args): { pid: number; logPath: string } {
  const logPath = createStartLogPath(resolveStartLogDir(args));
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");
  const childArgs = ["start", "--log-file"];
  if (typeof args["log-dir"] === "string") childArgs.push("--log-dir", String(args["log-dir"]));
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...childArgs], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: ["ignore", out, err],
  });
  child.unref();
  closeSync(out);
  closeSync(err);
  return { pid: child.pid ?? 0, logPath };
}

let shutdownHandlersInstalled = false;

/** Graceful shutdown for foreground/background daemons (§5.8). */
function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`[ocg] ${signal} received — stopping gateway...`);
    const forced = setTimeout(() => process.exit(0), 8000);
    forced.unref?.();
    void stopGateway()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

/** §5.8 single-instance guard: refuse to start when a live daemon answers health. */
async function refuseIfDaemonRunning(): Promise<void> {
  const health = await probeDaemonHealth(resolveDaemonEndpoint(), 1500);
  if (!health) return;
  console.error(
    `[ocg] Gateway already running (pid ${String(health.pid ?? "?")}). ` +
    `Use "ocg stop" or "ocg daemon stop" first.`,
  );
  process.exit(3);
}

async function cmdStart(args: Args = {}): Promise<void> {
  await refuseIfDaemonRunning();

  if (shouldStartInBackground(args)) {
    startGatewayInBackground(args);
    return;
  }

  if (shouldWriteStartLogsToFile(args)) {
    await runWithConsoleLogFile(resolveStartLogDir(args), startGateway);
    installShutdownHandlers();
    return;
  }

  try {
    await startGateway();
    installShutdownHandlers();
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

async function cmdStop(): Promise<void> {
  const state = readGatewayProcessState();
  if (state && isProcessRunning(state.pid)) {
    const result = await stopDaemonProcess(state.pid, 15_000);
    if (!result.stopped) {
      console.error(`[ocg] Failed to stop pid ${state.pid}: ${result.detail}`);
      process.exitCode = 1;
      return;
    }
    clearGatewayProcessState(state.pid);
    console.log(`[ocg] Stopped (pid ${state.pid}, ${result.detail})`);
    return;
  }
  if (state) clearGatewayProcessState(state.pid);
  await stopGateway();
  console.log("[ocg] Stopped");
}

async function cmdRestart(args: Args = {}): Promise<void> {
  await cmdStop();
  await cmdStart(args);
}

async function cmdStatus(args: Args = {}): Promise<void> {
  const s = gatewayStatus() as Record<string, unknown>;

  // Merge the daemon's /ocg/health view when reachable (§5.7).
  const endpoint = resolveDaemonEndpoint();
  const health = await probeDaemonHealth(endpoint, 1500);
  const daemonInfo = health
    ? {
        reachable: true,
        baseUrl: endpoint.baseUrl,
        version: health.version,
        pid: health.pid,
        uptimeMs: health.uptimeMs,
        mailbox: health.mailbox,
        healthChannels: health.channels,
      }
    : { reachable: false, baseUrl: endpoint.baseUrl, hint: "run: ocg daemon start" };

  if (args["json"]) {
    console.log(JSON.stringify({ ...s, daemon: daemonInfo }, null, 2));
    return;
  }

  console.log(`Agent type: ${String(s.agentType ?? "http")}`);
  console.log(`Agent:  ${String(s.agentUrl)}`);
  console.log(`Model:  ${String(s.model)}`);
  console.log(`Channels configured: ${String(s.configured)}, running: ${String(s.running)}`);
  const channels = s.channels as Array<Record<string, unknown>>;
  for (const c of channels) {
    const uptime = typeof c.uptime === "number" ? `${c.uptime}s` : "—";
    const chAgentUrl = c.agentUrl as string | undefined;
    const agentInfo = chAgentUrl && chAgentUrl !== s.agentUrl
      ? `  agent: ${chAgentUrl}`
      : "";
    console.log(`  ${c.id}  ${c.status}  uptime: ${uptime}${agentInfo}`);
  }
  if (health) {
    const mailbox = (health.mailbox ?? {}) as Record<string, unknown>;
    console.log(
      `Daemon: running (pid ${String(health.pid ?? "?")}, port ${endpoint.port}, v${String(health.version ?? "?")})`,
    );
    console.log(
      `Mailbox: ${mailbox.enabled === true ? "enabled" : "disabled"}` +
      ` (pending ${String(mailbox.pending ?? 0)}, leased ${String(mailbox.leased ?? 0)})`,
    );
  } else {
    console.log("Daemon: not reachable (run: ocg daemon start)");
  }
}

function resolveChatMessage(command: string, args: Args): string {
  const flagMessage = args.message ?? args.m;
  if (typeof flagMessage === "string") return flagMessage;
  if (command === "chat") return "";
  if (command.startsWith("chat ")) return command.slice("chat ".length).trim();
  return "";
}

function createTerminalDispatchContext(message: string, args: Args): Record<string, unknown> {
  const channelId = typeof args.channel === "string" ? args.channel : "terminal";
  const accountId = typeof args.account === "string" ? args.account : "default";
  const userId = typeof args.user === "string" ? args.user : "terminal";
  const sessionKey = typeof args.session === "string"
    ? args.session
    : `${channelId}:${accountId}:${userId}`;

  return {
    Body: message,
    BodyForAgent: message,
    CommandBody: message,
    RawBody: message,
    From: `${channelId}:${userId}`,
    SessionKey: sessionKey,
  };
}

async function dispatchTerminalMessage(message: string, args: Args): Promise<string> {
  const rawCfg = loadConfig() ?? {};
  if (typeof args["agent-type"] === "string") rawCfg.agentType = args["agent-type"] === "acp" ? "acp" : "http";
  if (typeof args["agent-url"] === "string") rawCfg.agentUrl = args["agent-url"];
  if (typeof args.model === "string") rawCfg.model = args.model;
  if (typeof args["api-key"] === "string") rawCfg.apiKey = args["api-key"];
  if (typeof args["acp-command"] === "string") {
    rawCfg.acp = { ...(rawCfg.acp ?? {}), command: args["acp-command"] };
    rawCfg.agentType = "acp";
  }
  if (typeof args["acp-args"] === "string") {
    try {
      rawCfg.acp = { ...(rawCfg.acp ?? {}), args: JSON.parse(args["acp-args"]) as string[] };
    } catch {
      rawCfg.acp = { ...(rawCfg.acp ?? {}), args: args["acp-args"].split(" ").filter(Boolean) };
    }
  }
  if (typeof args["acp-cwd"] === "string") {
    rawCfg.acp = { ...(rawCfg.acp ?? {}), cwd: args["acp-cwd"] };
  }

  applyConfigEnvOverrides(rawCfg);
  const cfg = buildOpenClawConfig(rawCfg);
  const { dispatchReplyWithBufferedBlockDispatcher } =
    await import("./shims/reply-dispatch-runtime.js");

  let finalText = "";
  const blockTexts: string[] = [];
  const quiet = args.quiet === true || args.q === true;
  const showBlocks = args.blocks === true || args.stream === true || args.verbose === true;

  const result = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: createTerminalDispatchContext(message, args),
    cfg,
    dispatcherOptions: {
      onModelSelected: async (model: string) => {
        if (!quiet) console.log(`[ocg:chat] model=${model}`);
      },
      deliver: async (payload: Record<string, unknown>, meta: Record<string, unknown>) => {
        const text = String(payload.text ?? "");
        if (meta.kind === "block") {
          blockTexts.push(text);
          if (showBlocks) console.log(`[block] ${text}`);
          return;
        }
        if (meta.kind === "final") {
          finalText = text;
          return;
        }
        if (!quiet) console.log(`[${String(meta.kind ?? "payload")}] ${text}`);
      },
    },
  });

  if (!quiet) {
    const counts = result.counts ? ` counts=${JSON.stringify(result.counts)}` : "";
    console.log(`[ocg:chat] done${counts}`);
  }

  return finalText || blockTexts.join("");
}

async function cmdChat(command: string, args: Args): Promise<void> {
  const interactive = args.interactive === true || args.i === true;
  const { stopAllAcpAgents } = await import("./acp-agent.js");

  if (!interactive) {
    let message = resolveChatMessage(command, args);
    let rl: ReturnType<typeof createInterface> | undefined;
    if (!message && input.isTTY) {
      rl = createInterface({ input, output });
      message = (await rl.question("> ")).trim();
    }
    if (!message) {
      rl?.close();
      console.error("Usage: ocg chat <message> [--channel <id>] [--account <id>] [--session <key>]");
      console.error("       ocg chat --interactive [--channel <id>] [--account <id>]");
      process.exit(1);
    }
    try {
      const reply = await dispatchTerminalMessage(message, args);
      console.log("\n--- final ---");
      console.log(reply);
    } finally {
      rl?.close();
      stopAllAcpAgents();
    }
    return;
  }

  const rl = createInterface({ input, output });
  console.log("[ocg:chat] Interactive terminal chat. Type /exit or /quit to leave.");
  try {
    while (true) {
      const message = (await rl.question("> ")).trim();
      if (!message) continue;
      if (message === "/exit" || message === "/quit") break;
      const reply = await dispatchTerminalMessage(message, args);
      console.log("\n--- final ---");
      console.log(reply);
    }
  } finally {
    rl.close();
    stopAllAcpAgents();
  }
}

/**
 * `ocg send` — proactive send from the CLI.
 *
 * Prefers the running daemon (`POST /ocg/send` with the local token): the
 * daemon already has every plugin (and its runtime) loaded, so this avoids the
 * 1–3 s plugin load and shares account runtime state.  Falls back to the
 * in-process implementation when the daemon is not running (or when
 * `--chunk-prefix` overrides config the HTTP contract cannot carry) and marks
 * the result with `inProcess: true`.
 *
 * Exit codes: 0 ok / 1 platform failure / 2 bad arguments / 3 disabled,
 * not-ready or no outbound adapter.
 */
function sendExitCode(code: unknown): number {
  switch (code) {
    case undefined:
    case null:
      return 0;
    case "PLATFORM_SEND_FAILED":
      return 1;
    case "DISABLED":
    case "NOT_READY":
    case "NO_OUTBOUND_ADAPTER":
    case "INTERNAL_ERROR":
    case "UNAUTHORIZED":
    case "DAEMON_NOT_RUNNING":
    case "MAILBOX_DISABLED":
      return 3;
    default:
      return 2;
  }
}

async function cmdSend(args: Args): Promise<void> {
  const json = args["json"] === true;
  const emit = (body: Record<string, unknown>, exitCode: number): number => {
    if (json) {
      console.log(JSON.stringify(body, null, 2));
    } else if (body.ok === true) {
      const messageId = body.messageId ? `, messageId=${body.messageId}` : "";
      const degraded = body.degraded === true ? ", degraded" : "";
      const via = body.inProcess === true ? ", in-process" : "";
      console.log(
        `[ocg] sent to ${String(body.to)} (channel=${String(body.channel)}, ` +
        `chunks=${String(body.chunks)}${messageId}${degraded}${via}, ${String(body.elapsedMs)}ms)`,
      );
    } else {
      const partial = body.partial === true
        ? ` (partial: ${String(body.chunksSent)}/${String(body.chunksTotal)} chunks sent)`
        : "";
      console.error(`[ocg] send failed: ${String(body.code)} — ${String(body.message)}${partial}`);
    }
    return exitCode;
  };

  const rawCfg = loadConfig();
  if (!rawCfg) {
    console.error("[ocg] No config found. Create ocg.json first.");
    process.exitCode = 2;
    return;
  }

  const settings = resolveSendSettings(rawCfg);
  if (args["chunk-prefix"] === true) settings.chunkPrefix = true;

  if (!settings.enabled) {
    process.exitCode = emit(
      {
        ok: false,
        code: "DISABLED",
        message: "proactive send is disabled: configure sendSecret or callbackSecret to enable it",
      },
      3,
    );
    return;
  }

  const channel = typeof args.channel === "string" ? args.channel : undefined;
  const to = typeof args.to === "string" ? args.to : undefined;
  const text = typeof args.text === "string" ? args.text : undefined;
  const mediaUrl = typeof args["media-url"] === "string" ? (args["media-url"] as string) : undefined;
  const accountId = typeof args.account === "string" ? args.account : undefined;
  const replyToId = typeof args["reply-to"] === "string" ? (args["reply-to"] as string) : undefined;

  if (!channel || !to || ((text ?? "").trim() === "" && !mediaUrl)) {
    process.exitCode = emit(
      {
        ok: false,
        code: "INVALID_REQUEST",
        message: "usage: ocg send --channel <id> --to <target> (--text <text> | --media-url <url>)",
      },
      2,
    );
    return;
  }

  // ── Daemon-first path ────────────────────────────────────────────────────
  // `--chunk-prefix` is a CLI-only override the /ocg/send contract cannot
  // express, so it keeps using the in-process implementation.
  if (args["chunk-prefix"] !== true) {
    const response = await daemonRequest(resolveDaemonEndpoint(), "POST", "/ocg/send", {
      body: { channel, to, text, mediaUrl, accountId, replyToId },
      timeoutMs: settings.timeoutMs + 5_000,
    });
    if (response.ok) {
      process.exitCode = emit({ ...response.body, inProcess: false }, sendExitCode(response.body.code));
      return;
    }
    if (response.code !== "DAEMON_NOT_RUNNING") {
      process.exitCode = emit(
        {
          ok: false,
          code: response.code,
          message: response.message,
          ...(response.hint ? { hint: response.hint } : {}),
          inProcess: false,
        },
        sendExitCode(response.code),
      );
      return;
    }
    // Daemon not running → the in-process fallback below keeps working.
  }

  applyConfigEnvOverrides(rawCfg);
  const cfg = buildOpenClawConfig(rawCfg);

  try {
    // Plugin loading happens on demand inside executeSend (single-channel,
    // fast) — no need to boot every installed plugin.
    const outcome = await executeSend({
      cfg,
      settings,
      request: { channel, to, text, mediaUrl, accountId, replyToId },
    });
    process.exitCode = emit({ ...outcome.body, inProcess: true }, sendExitCode(outcome.body.code));
  } catch (err) {
    process.exitCode = emit(
      { ok: false, code: "INTERNAL_ERROR", message: (err as Error).message, inProcess: true },
      3,
    );
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
    const s = gatewayStatus();
    const entry = (s.channels as Array<Record<string, unknown>>).find((c) => c.id === channelId) ?? getChannelStatus(channelId);
    if (args["json"]) {
      console.log(JSON.stringify(entry ?? { status: "not-found" }, null, 2));
    } else if (entry) {
      const statusEntry = entry as Record<string, unknown>;
      const id = (statusEntry.channelId ?? statusEntry.id) as string;
      const uptime = typeof statusEntry.uptime === "number"
        ? statusEntry.uptime
        : Math.round((Date.now() - ((statusEntry.startedAt as number | undefined) ?? Date.now())) / 1000);
      console.log(`${id}: ${statusEntry.status} (uptime: ${uptime}s)`);
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

  // Start callback server for async dispatch (only if not already running).
  // Prepare the local token first so agent routes are reachable by the CLI.
  if (!isCallbackServerRunning()) {
    try {
      ensureLocalToken();
    } catch (err) {
      console.warn(`[ocg] Failed to prepare local token: ${(err as Error).message}`);
    }
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

// ── Daemon & mailbox commands (§5.7) ──────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function autoStartEnabled(args: Args): boolean {
  return args["auto-start"] === true || process.env.OCG_AUTO_START === "1";
}

type DaemonStartResult = {
  ok: boolean;
  pid?: number;
  port: number;
  channels: unknown[];
  logPath: string;
};

/**
 * Spawn the daemon in the background and poll `/ocg/health` until ready.
 *
 * Readiness (design §5.8, adjusted for real cold-start cost): accept a healthy
 * daemon once a channel reports running, or — channel logins / plugin loads
 * can take far longer than a fresh boot suggests — once health has been up for
 * at least 30 s; give up at `waitMs` (default 120 s).  Plugin loading alone can
 * exceed a minute on a cold cache, so a pure 30 s window mis-reports success
 * on slow machines (observed: ~73 s to first health).
 */
async function startDaemonAndWait(args: Args, waitMs = 120_000): Promise<DaemonStartResult> {
  const startedAt = Date.now();
  const { pid, logPath } = spawnDaemonProcess(args);
  let health: Record<string, unknown> | null = null;

  while (Date.now() - startedAt < waitMs) {
    await sleep(500);
    const probe = await probeDaemonHealth(resolveDaemonEndpoint(), 2000);
    if (!probe) continue;
    health = probe;
    const channels = Array.isArray(probe.channels) ? (probe.channels as Array<Record<string, unknown>>) : [];
    const anyRunning = channels.some((channel) => channel.status === "running");
    if (anyRunning || Date.now() - startedAt >= 30_000) break;
  }
  if (!health) health = await probeDaemonHealth(resolveDaemonEndpoint(), 2000);

  return {
    ok: health !== null,
    pid: typeof health?.pid === "number" ? (health.pid as number) : pid,
    port: resolveDaemonEndpoint().port,
    channels: Array.isArray(health?.channels) ? (health?.channels as unknown[]) : [],
    logPath,
  };
}

async function cmdDaemonStart(args: Args): Promise<void> {
  const json = args["json"] === true;
  const existing = await probeDaemonHealth(resolveDaemonEndpoint(), 1500);
  if (existing) {
    const body = {
      ok: false,
      code: "ALREADY_RUNNING",
      message: `daemon already running (pid ${String(existing.pid ?? "?")})`,
      hint: "use: ocg daemon status",
    };
    if (json) console.log(JSON.stringify(body, null, 2));
    else console.log(`[ocg] ${body.message}`);
    process.exitCode = 3;
    return;
  }

  const timeoutRaw = typeof args.timeout === "string" ? Number.parseInt(args.timeout, 10) : 120;
  const waitMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 600) * 1000 : 120_000;

  const result = await startDaemonAndWait(args, waitMs);
  if (result.ok) {
    const body = { ok: true, pid: result.pid, port: result.port, channels: result.channels };
    if (json) console.log(JSON.stringify(body, null, 2));
    else console.log(`[ocg] Daemon ready (pid ${result.pid}, port ${result.port}). Logs: ${result.logPath}`);
    return;
  }
  const body = {
    ok: false,
    code: "START_TIMEOUT",
    message: `daemon did not answer /ocg/health within ${Math.round(waitMs / 1000)}s`,
    hint: `check the logs: ${result.logPath}`,
  };
  if (json) console.log(JSON.stringify(body, null, 2));
  else console.error(`[ocg] ${body.message}\n[ocg] ${body.hint}`);
  process.exitCode = 3;
}

async function cmdDaemonStop(args: Args): Promise<void> {
  const json = args["json"] === true;
  const timeoutRaw = typeof args.timeout === "string" ? Number.parseInt(args.timeout, 10) : 10;
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.min(timeoutRaw, 300) * 1000
    : 10_000;

  const state = readGatewayProcessState();
  if (!state || !isProcessRunning(state.pid)) {
    if (state) clearGatewayProcessState(state.pid);
    const body = { ok: true, stopped: false, message: "daemon is not running" };
    if (json) console.log(JSON.stringify(body, null, 2));
    else console.log("[ocg] Daemon is not running.");
    return;
  }

  const result = await stopDaemonProcess(state.pid, timeoutMs);
  if (result.stopped) {
    clearGatewayProcessState(state.pid);
    const body = { ok: true, stopped: true, pid: state.pid, detail: result.detail };
    if (json) console.log(JSON.stringify(body, null, 2));
    else console.log(`[ocg] Daemon stopped (pid ${state.pid}, ${result.detail}).`);
    return;
  }
  const body = { ok: false, code: "STOP_TIMEOUT", message: result.detail };
  if (json) console.log(JSON.stringify(body, null, 2));
  else console.error(`[ocg] Failed to stop daemon: ${result.detail}`);
  process.exitCode = 1;
}

async function cmdDaemonStatus(args: Args): Promise<void> {
  const json = args["json"] === true;
  const endpoint = resolveDaemonEndpoint();
  const health = await probeDaemonHealth(endpoint, 2500);
  if (health) {
    const body = { ok: true, reachable: true, baseUrl: endpoint.baseUrl, ...health };
    if (json) console.log(JSON.stringify(body, null, 2));
    else {
      console.log(`Daemon:  running (pid ${String(health.pid ?? "?")}, ${endpoint.baseUrl}, v${String(health.version ?? "?")})`);
      console.log(`Mailbox: ${(health.mailbox as Record<string, unknown> | undefined)?.enabled === true ? "enabled" : "disabled"} (pending: ${String((health.mailbox as Record<string, unknown> | undefined)?.pending ?? 0)})`);
      const channels = Array.isArray(health.channels) ? (health.channels as Array<Record<string, unknown>>) : [];
      for (const channel of channels) {
        console.log(`  ${String(channel.id)}/${String(channel.accountId ?? "-")}  ${String(channel.status)}`);
      }
    }
    return;
  }

  const state = readGatewayProcessState();
  const body = {
    ok: false,
    reachable: false,
    code: "DAEMON_NOT_RUNNING",
    baseUrl: endpoint.baseUrl,
    ...(state
      ? {
          statePid: state.pid,
          stateAlive: isProcessRunning(state.pid),
          startedAt: state.startedAt,
          callbackPort: state.callbackPort,
        }
      : {}),
    hint: "run: ocg daemon start",
  };
  if (json) console.log(JSON.stringify(body, null, 2));
  else console.error(`[ocg] Daemon not reachable at ${endpoint.baseUrl}\n[ocg] ${body.hint}`);
  process.exitCode = 3;
}

async function cmdDaemonLogs(args: Args): Promise<void> {
  const json = args["json"] === true;
  const tailRaw = typeof args.tail === "string" ? Number.parseInt(args.tail, 10) : 100;
  const tailCount = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(tailRaw, 5000) : 100;
  const follow = args.follow === true || args.f === true;

  const file = latestLogFile();
  if (!file) {
    if (json) console.log(JSON.stringify({ ok: true, file: null, lines: [] }, null, 2));
    else console.log(`[ocg] No logs yet in ${resolveDaemonLogDir()}`);
    return;
  }

  const lines = readLastLines(file, tailCount);
  if (json && !follow) {
    console.log(JSON.stringify({ ok: true, file, lines }, null, 2));
    return;
  }
  if (json) console.log(JSON.stringify({ ok: true, file, lines }, null, 2));
  else {
    for (const line of lines) console.log(line);
  }

  if (follow) {
    if (!json) console.log(`\n[ocg] Following ${file} (Ctrl+C to stop)\n`);
    let stopped = false;
    process.once("SIGINT", () => {
      stopped = true;
    });
    await followLogFile(file, (text) => process.stdout.write(text), () => stopped);
  }
}

async function cmdDaemon(command: string, args: Args): Promise<void> {
  const sub = command.split(/\s+/)[1];
  switch (sub) {
    case "start": return cmdDaemonStart(args);
    case "stop": return cmdDaemonStop(args);
    case "status": return cmdDaemonStatus(args);
    case "logs": return cmdDaemonLogs(args);
    default:
      console.error("Usage: ocg daemon <start|stop|status|logs>");
      process.exitCode = 2;
  }
}

/** Run a "must" mailbox command, honouring --auto-start / OCG_AUTO_START. */
async function daemonCall(
  args: Args,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; timeoutMs?: number } = {},
): Promise<DaemonResponse> {
  let response = await daemonRequest(resolveDaemonEndpoint(), method, path, options);
  if (!response.ok && response.code === "DAEMON_NOT_RUNNING" && autoStartEnabled(args)) {
    console.error("[ocg] daemon not running — starting it (--auto-start)...");
    const started = await startDaemonAndWait(args);
    if (started.ok) {
      response = await daemonRequest(resolveDaemonEndpoint(), method, path, options);
    }
  }
  return response;
}

function queryExitCode(code: string): number {
  switch (code) {
    case "INVALID_REQUEST":
    case "NOT_FOUND":
      return 2;
    default:
      return 3;
  }
}

function replyExitCode(code: string): number {
  switch (code) {
    case "PLATFORM_SEND_FAILED":
    case "REPLY_EXPIRED":
    case "ALREADY_REPLIED":
    case "LEASE_HELD_BY_OTHER":
    case "DELIVER_FAILED":
      return 1;
    case "DAEMON_NOT_RUNNING":
    case "UNAUTHORIZED":
    case "MAILBOX_DISABLED":
    case "DISABLED":
    case "NOT_READY":
    case "NO_OUTBOUND_ADAPTER":
    case "INTERNAL_ERROR":
      return 3;
    default:
      return 2;
  }
}

function ackExitCode(code: string): number {
  switch (code) {
    case "NOT_FOUND":
    case "INVALID_REQUEST":
      return 2;
    case "LEASE_HELD_BY_OTHER":
      return 1;
    default:
      return 3;
  }
}

function reportFailure(
  response: { code: string; message: string; hint?: string },
  json: boolean,
  exitCode: number,
): void {
  const body: Record<string, unknown> = { ok: false, code: response.code, message: response.message };
  if (response.hint) body.hint = response.hint;
  if (json) console.log(JSON.stringify(body, null, 2));
  else console.error(`[ocg] ${response.code}: ${response.message}${response.hint ? `\n[ocg] ${response.hint}` : ""}`);
  process.exitCode = exitCode;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdInboxWait(args: Args): Promise<void> {
  const json = args["json"] === true;
  let timeoutSec = typeof args.timeout === "string" ? Number.parseInt(args.timeout, 10) : 60;
  if (!Number.isFinite(timeoutSec)) timeoutSec = 60;
  timeoutSec = Math.min(Math.max(timeoutSec, 0), 120);

  const params = new URLSearchParams();
  params.set("timeoutMs", String(timeoutSec * 1000));
  if (typeof args.channel === "string") params.set("channel", args.channel);
  if (typeof args.consumer === "string") params.set("consumer", args.consumer);
  if (typeof args.max === "string") params.set("max", args.max);
  if (args.peek === true) params.set("peek", "1");

  const response = await daemonCall(args, "GET", `/ocg/inbox/wait?${params.toString()}`, {
    timeoutMs: timeoutSec * 1000 + 15_000,
  });
  if (!response.ok) return reportFailure(response, json, queryExitCode(response.code));

  const messages = Array.isArray(response.body.messages)
    ? (response.body.messages as Array<Record<string, unknown>>)
    : [];
  if (json) {
    console.log(JSON.stringify(response.body, null, 2));
    return;
  }
  if (messages.length === 0) {
    console.log(`[ocg] No messages (waited ${timeoutSec}s).`);
    return;
  }
  for (const message of messages) {
    const text = typeof message.text === "string" ? message.text.replace(/\n/g, "\\n") : "";
    const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;
    console.log(
      `[ocg] ${String(message.id)}  ${String(message.channel)}  ${String(message.chatType)}` +
      `  ${message.replyable === true ? "replyable" : "send-only"}`,
    );
    if (preview) console.log(`      ${preview}`);
  }
}

async function cmdInboxList(args: Args): Promise<void> {
  const json = args["json"] === true;
  const params = new URLSearchParams();
  if (typeof args.state === "string") params.set("state", args.state);
  if (typeof args.limit === "string") params.set("limit", args.limit);
  if (typeof args.channel === "string") params.set("channel", args.channel);
  if (typeof args.since === "string") params.set("since", args.since);
  const queryString = params.toString();
  const response = await daemonCall(args, "GET", `/ocg/inbox${queryString ? `?${queryString}` : ""}`);
  if (!response.ok) return reportFailure(response, json, queryExitCode(response.code));

  const entries = Array.isArray(response.body.entries)
    ? (response.body.entries as Array<Record<string, unknown>>)
    : [];
  if (json) {
    console.log(JSON.stringify(response.body, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log("[ocg] No messages.");
    return;
  }
  for (const entry of entries) {
    const received = typeof entry.receivedAt === "number" ? new Date(entry.receivedAt).toISOString() : "";
    console.log(
      `[ocg] ${String(entry.id)}  ${String(entry.state)}  ${String(entry.channel)}  ` +
      `${String(entry.chatType)}  ${received}` +
      `${entry.consumer ? `  consumer=${String(entry.consumer)}` : ""}`,
    );
  }
}

async function cmdInboxShow(id: string | undefined, args: Args): Promise<void> {
  const json = args["json"] === true;
  if (!id) {
    console.error("Usage: ocg inbox show <id> [--json]");
    process.exitCode = 2;
    return;
  }
  const response = await daemonCall(args, "GET", `/ocg/inbox/${encodeURIComponent(id)}`);
  if (!response.ok) return reportFailure(response, json, queryExitCode(response.code));
  if (json) {
    console.log(JSON.stringify(response.body, null, 2));
    return;
  }

  const entry = (response.body.entry ?? {}) as Record<string, unknown>;
  const sender = (entry.sender ?? {}) as Record<string, unknown>;
  const replyExpires = typeof entry.replyExpiresAt === "number" ? new Date(entry.replyExpiresAt).toISOString() : "?";
  console.log(`id:         ${String(entry.id)}`);
  console.log(`channel:    ${String(entry.channel)} (account ${String(entry.accountId)})`);
  console.log(`state:      ${String(entry.state)}${entry.consumer ? `  consumer=${String(entry.consumer)}` : ""}`);
  console.log(`target:     ${String(entry.target ?? "(unknown)")}`);
  console.log(`sessionKey: ${String(entry.sessionKey)}`);
  console.log(`replyable:  ${entry.replyable === true ? `yes (until ${replyExpires})` : "no (reply degrades to send)"}`);
  console.log(`sender:     ${String(sender.id ?? "?")} ${sender.name ? `(${String(sender.name)})` : ""}`);
  const media = Array.isArray(entry.media) ? (entry.media as Array<Record<string, unknown>>) : [];
  for (const [index, item] of media.entries()) {
    console.log(`media[${index}]:  path=${String(item.path ?? "(null — use show again later)")}  url=${String(item.url ?? "?")}  mime=${String(item.mime ?? "?")}`);
  }
  console.log(`text:\n${String(entry.text ?? "")}`);
}

async function cmdInboxAck(id: string | undefined, args: Args): Promise<void> {
  const json = args["json"] === true;
  if (!id) {
    console.error("Usage: ocg inbox ack <id> [--force] [--consumer <name>] [--json]");
    process.exitCode = 2;
    return;
  }
  const body: Record<string, unknown> = {};
  if (typeof args.consumer === "string") body.consumer = args.consumer;
  if (args.force === true) body.force = true;
  const response = await daemonCall(args, "POST", `/ocg/inbox/${encodeURIComponent(id)}/ack`, { body });
  if (!response.ok) return reportFailure(response, json, ackExitCode(response.code));
  if (json) console.log(JSON.stringify(response.body, null, 2));
  else console.log(`[ocg] ${id} acked.`);
}

async function cmdInbox(command: string, args: Args): Promise<void> {
  const tokens = command.split(/\s+/).filter(Boolean);
  const sub = tokens[1];
  switch (sub) {
    case "wait": return cmdInboxWait(args);
    case "list": return cmdInboxList(args);
    case "show": return cmdInboxShow(tokens[2], args);
    case "ack": return cmdInboxAck(tokens[2], args);
    default:
      console.error("Usage: ocg inbox <wait|list|show|ack> [options]");
      process.exitCode = 2;
  }
}

async function cmdReply(command: string, args: Args): Promise<void> {
  const json = args["json"] === true;
  const tokens = command.split(/\s+/).filter(Boolean);
  const id = tokens[1];
  if (!id) {
    console.error("Usage: ocg reply <id> (--text <text> | --text-file <path> | -) [--media <url-or-path>] [--error] [--json]");
    process.exitCode = 2;
    return;
  }

  let text: string | undefined;
  const textFile = typeof args["text-file"] === "string" ? args["text-file"] : undefined;
  const wantsStdin = tokens.includes("-") || args.text === "-";
  if (typeof args.text === "string" && args.text !== "-") {
    text = args.text;
  } else if (textFile) {
    try {
      text = readFileSync(resolve(textFile), "utf8");
    } catch (err) {
      console.error(`[ocg] cannot read --text-file: ${(err as Error).message}`);
      process.exitCode = 2;
      return;
    }
  } else if (wantsStdin) {
    text = await readStdin();
  }

  const mediaUrl = typeof args.media === "string" ? args.media : undefined;
  const isError = args.error === true;
  if ((text ?? "").trim() === "" && !mediaUrl) {
    console.error("Usage: ocg reply <id> (--text <text> | --text-file <path> | -) [--media <url-or-path>] [--error] [--json]");
    process.exitCode = 2;
    return;
  }

  const body: Record<string, unknown> = {};
  if (text !== undefined) body.text = text;
  if (mediaUrl) body.mediaUrl = mediaUrl;
  if (isError) body.isError = true;
  if (typeof args.consumer === "string") body.consumer = args.consumer;
  if (args.force === true) body.force = true;

  const response = await daemonCall(args, "POST", `/ocg/inbox/${encodeURIComponent(id)}/reply`, {
    body,
    timeoutMs: 60_000,
  });
  if (!response.ok) return reportFailure(response, json, replyExitCode(response.code));

  if (json) {
    console.log(JSON.stringify(response.body, null, 2));
    if (response.body.ok !== true) {
      process.exitCode = replyExitCode(String(response.body.code ?? ""));
    }
    return;
  }
  console.log(
    `[ocg] replied ${id} via ${String(response.body.via)} ` +
    `(chunks=${String(response.body.chunks ?? "?")}, ${String(response.body.elapsedMs ?? "?")}ms)`,
  );
  const notes = Array.isArray(response.body.notes) ? (response.body.notes as unknown[]) : [];
  for (const note of notes) console.log(`[ocg] note: ${String(note)}`);
}

async function cmdTargets(command: string, args: Args): Promise<void> {
  const json = args["json"] === true;
  if (command.split(/\s+/)[1] !== "list") {
    console.error("Usage: ocg targets list [--channel <id>] [--limit <n>] [--json]");
    process.exitCode = 2;
    return;
  }
  const params = new URLSearchParams();
  if (typeof args.channel === "string") params.set("channel", args.channel);
  if (typeof args.limit === "string") params.set("limit", args.limit);
  const queryString = params.toString();
  const response = await daemonCall(args, "GET", `/ocg/targets${queryString ? `?${queryString}` : ""}`);
  if (!response.ok) return reportFailure(response, json, queryExitCode(response.code));

  const targets = Array.isArray(response.body.targets)
    ? (response.body.targets as Array<Record<string, unknown>>)
    : [];
  if (json) {
    console.log(JSON.stringify(response.body, null, 2));
    return;
  }
  if (targets.length === 0) {
    console.log("[ocg] No targets seen yet.");
    return;
  }
  for (const target of targets) {
    const lastSeen = typeof target.lastSeenAt === "number" ? new Date(target.lastSeenAt).toISOString() : "?";
    console.log(
      `${String(target.channel)}  ${String(target.target)}  ${String(target.chatType)}  ` +
      `last ${lastSeen}  count ${String(target.count)}`,
    );
  }
}

// ── doctor (§5.11) ────────────────────────────────────────────────────────

type DoctorCheck = { name: string; ok: boolean; warn?: boolean; detail?: string; hint?: string };

async function cmdDoctor(args: Args): Promise<void> {
  const json = args["json"] === true;
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, extra: Partial<DoctorCheck> = {}): void => {
    checks.push({ name, ok, ...extra });
  };

  // Node >= 22.12
  const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  const nodeOk = major > 22 || (major === 22 && minor >= 12);
  add("Node.js >= 22.12", nodeOk, nodeOk
    ? { detail: `v${process.versions.node}` }
    : { detail: `v${process.versions.node}`, hint: "upgrade Node.js" });

  // Config file
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    add("config file", false, { detail: `not found: ${configPath}`, hint: "create ocg.json (see ocg.example.json)" });
  } else {
    try {
      JSON.parse(readFileSync(configPath, "utf8"));
      add("config file", true, { detail: configPath });
    } catch (err) {
      add("config file", false, { detail: `invalid JSON: ${(err as Error).message}`, hint: `fix ${configPath}` });
    }
  }

  // Channels
  const configured = listConfiguredChannels();
  add("at least one channel enabled", configured.length > 0, configured.length > 0
    ? { detail: configured.join(", ") }
    : { detail: "none", hint: "ocg channels add --channel <id> ..." });

  // Mailbox mode
  const raw = loadConfig() ?? {};
  const mailboxOn = isMailboxConfigured(raw);
  add('mailbox mode (agentType: "mailbox")', mailboxOn, mailboxOn
    ? { detail: "enabled" }
    : { detail: "disabled — inbox/reply need it", hint: 'set "agentType": "mailbox" globally or on a channel in ocg.json' });

  // Daemon process state
  const state = readGatewayProcessState();
  const stateAlive = Boolean(state && isProcessRunning(state.pid));
  add("daemon state file pid alive", stateAlive, stateAlive
    ? { detail: `pid ${state!.pid}` }
    : { detail: state ? `pid ${state.pid} is dead` : "no state file (never started as a daemon)", hint: "run: ocg daemon start" });

  // Health + local token (health requires auth → 200 proves both)
  const endpoint = resolveDaemonEndpoint();
  const healthResponse = await daemonRequest(endpoint, "GET", "/ocg/health", { timeoutMs: 2500 });
  if (healthResponse.ok) {
    add("/ocg/health reachable", true, { detail: `${endpoint.baseUrl} (v${String(healthResponse.body.version ?? "?")})` });
    add("local token accepted", true, { detail: resolveLocalTokenPath() });
  } else {
    add("/ocg/health reachable", false, {
      detail: healthResponse.code === "DAEMON_NOT_RUNNING" ? `not reachable at ${endpoint.baseUrl}` : `${healthResponse.code}: ${healthResponse.message}`,
      hint: healthResponse.code === "UNAUTHORIZED"
        ? "restart the daemon to regenerate <configDir>/ocg-local-token"
        : "check port/firewall or OCG_DAEMON_URL; then: ocg daemon start",
    });
    add("local token accepted", false, {
      detail: healthResponse.code === "UNAUTHORIZED" ? "daemon rejected the token" : "unknown (daemon not reachable)",
      hint: "restart the daemon",
    });
  }

  // Channels running + mailbox backlog (only meaningful with health)
  if (healthResponse.ok) {
    const channels = Array.isArray(healthResponse.body.channels)
      ? (healthResponse.body.channels as Array<Record<string, unknown>>)
      : [];
    const running = channels.filter((channel) => channel.status === "running");
    add("channel(s) running", running.length > 0, running.length > 0
      ? { detail: running.map((channel) => `${String(channel.id)}/${String(channel.accountId ?? "-")}`).join(", ") }
      : { detail: "none running", hint: "ocg channels login --channel <id> / ocg daemon logs" });

    const mailbox = (healthResponse.body.mailbox ?? {}) as Record<string, unknown>;
    const pending = Number(mailbox.pending ?? 0);
    const oldest = typeof mailbox.oldestPendingAt === "number" ? mailbox.oldestPendingAt : null;
    const stale = oldest !== null && Date.now() - oldest > 10 * 60_000;
    const backlogProblem = pending > 100 || stale;
    checks.push({
      name: "mailbox backlog",
      ok: !backlogProblem,
      warn: true,
      detail: backlogProblem
        ? `${pending} pending, oldest ${oldest ? new Date(oldest).toISOString() : "?"}`
        : `${pending} pending`,
    });
  }

  const failed = checks.filter((check) => !check.ok && check.warn !== true);
  const body = {
    ok: failed.length === 0,
    checks: checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      ...(check.warn === true ? { warn: true } : {}),
      ...(check.detail ? { detail: check.detail } : {}),
      ...(check.hint ? { hint: check.hint } : {}),
    })),
  };

  if (json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    for (const check of checks) {
      const mark = check.ok ? "✓" : check.warn === true ? "!" : "✗";
      console.log(`${mark} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
      if (!check.ok && check.hint) console.log(`   hint: ${check.hint}`);
    }
    console.log("");
    console.log(failed.length === 0 ? "[ocg] doctor: OK" : `[ocg] doctor: ${failed.length} problem(s)`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// ── skill (§5.10) ─────────────────────────────────────────────────────────

async function cmdSkill(command: string, args: Args): Promise<void> {
  const json = args["json"] === true;
  const sub = command.split(/\s+/)[1];

  if (sub === "show") {
    process.stdout.write(buildSkillMarkdown(VERSION));
    return;
  }
  if (sub !== "install") {
    console.error("Usage: ocg skill <install|show> [--dir <path>] [--force] [--json]");
    process.exitCode = 2;
    return;
  }

  const content = buildSkillMarkdown(VERSION);
  const targets: string[] = [join(homedir(), ".claude", "skills", "ocg")];
  if (existsSync(join(process.cwd(), ".agents"))) {
    targets.push(join(process.cwd(), ".agents", "skills", "ocg"));
  }
  if (typeof args.dir === "string" && args.dir.trim() !== "") {
    targets.push(resolve(args.dir));
  }

  const force = args.force === true;
  const results: Array<{ path: string; status: string }> = [];
  for (const dir of targets) {
    const file = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8");
      if (existing === content) {
        results.push({ path: file, status: "up-to-date" });
        continue;
      }
      if (!force) {
        results.push({ path: file, status: "exists-different" });
        continue;
      }
    }
    writeFileSync(file, content, "utf8");
    results.push({ path: file, status: "installed" });
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, results }, null, 2));
    return;
  }
  for (const result of results) {
    if (result.status === "installed") console.log(`[ocg] installed: ${result.path}`);
    else if (result.status === "up-to-date") console.log(`[ocg] already up to date: ${result.path}`);
    else console.log(`[ocg] exists with different content (use --force to overwrite): ${result.path}`);
  }
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
  if (command === "send") return cmdSend(args);

  // Daemon / mailbox / agent commands
  if (command === "doctor") return cmdDoctor(args);
  if (command === "reply" || command.startsWith("reply ")) return cmdReply(command, args);
  if (command === "inbox" || command.startsWith("inbox ")) return cmdInbox(command, args);
  if (command === "daemon" || command.startsWith("daemon ")) return cmdDaemon(command, args);
  if (command === "targets" || command.startsWith("targets ")) return cmdTargets(command, args);
  if (command === "skill" || command.startsWith("skill ")) return cmdSkill(command, args);

  switch (command) {
    case "stop": return cmdStop();
    case "restart": return cmdRestart(args);
    case "status": return cmdStatus(args);
    case "chat": return cmdChat(command, args);
    case "test": return cmdTest();
    case "upgrade": return cmdUpgrade(args);
  }
  if (command.startsWith("chat ")) return cmdChat(command, args);

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
