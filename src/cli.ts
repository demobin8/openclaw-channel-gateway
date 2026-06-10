/**
 * Lite Gateway CLI — mirrors `openclaw channels` command surface.
 *
 * Usage:
 *   lite-gateway start                     启动全部
 *   lite-gateway stop                      停止全部
 *   lite-gateway restart                   重启全部
 *   lite-gateway status                    网关状态
 *   lite-gateway version                   版本
 *
 *   lite-gateway channels list [--json]    列出 channels
 *   lite-gateway channels status [--channel <name>] [--json]
 *   lite-gateway channels start --channel <name>
 *   lite-gateway channels stop --channel <name>
 *   lite-gateway channels restart --channel <name>
 *   lite-gateway channels add --channel <name> [--token <token>] [--<key> <value> ...]
 *   lite-gateway channels remove --channel <name>
 */

import {
  startGateway,
  stopGateway,
  gatewayStatus,
  loadConfig,
  addChannel,
  removeChannel,
  listConfiguredChannels,
  listAllChannels,
  resolveConfigPath,
} from "./index.js";
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
} from "./plugin-loader.js";

const VERSION = "1.0.0";

// ── Helpers ───────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log(
    "╔══════════════════════════════════════════════╗\n" +
    "║       Lite Gateway v1.0.0                      ║\n" +
    "║   OpenClaw IM bridge → External Agent API     ║\n" +
    "╚══════════════════════════════════════════════╝",
  );
}

function printHelp(): void {
  printBanner();
  console.log("");
  console.log("Usage: lite-gateway <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  start                         Start all enabled channels");
  console.log("  stop                          Stop all channels");
  console.log("  restart                       Restart all channels");
  console.log("  status                        Show gateway status");
  console.log("  test                          Run dispatch smoke test");
  console.log("  version                       Print version");
  console.log("");
  console.log("  channels list [--all] [--json]  List channels");
  console.log("  channels status [--channel] [--json]  Show channel status");
  console.log("  channels start --channel <id>    Start a channel");
  console.log("  channels stop --channel <id>     Stop a channel");
  console.log("  channels restart --channel <id>  Restart a channel");
  console.log("  channels add --channel <id> [--<k> <v> ...]  Add a channel");
  console.log("  channels remove --channel <id>   Remove a channel");
  console.log("");
  console.log("  plugins install <pkg>            Install a channel plugin (npm install)");
  console.log("  plugins list                     List installed channel plugins");
  console.log("");
  console.log("Environment:");
  console.log("  LITE_GATEWAY_CONFIG_PATH     Config file path");
  console.log("  LITE_GATEWAY_AGENT_URL       Agent API URL");
  console.log("  LITE_GATEWAY_MODEL           Model name");
  console.log("  LITE_GATEWAY_API_KEY         API key");
  console.log("  LITE_GATEWAY_TELEGRAM_TOKEN  Telegram bot token");
}

// ── Arg parser (simple positional + flags, no Commander dependency) ────────

type Args = Record<string, string | boolean>;

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

  console.log("[lite-gateway] Running dispatch test...\n");

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

  process.env.LITE_GATEWAY_AGENT_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.LITE_GATEWAY_MODEL = "gpt-4o";
  process.env.LITE_GATEWAY_API_KEY = "test-key";

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
  console.log(`Model selected: ${process.env.LITE_GATEWAY_MODEL}`);
  console.log(`Collected blocks:`, collectedTexts);
  console.log(`Final text: ${finalText}`);
  console.log(`Result counts:`, result.counts);
  console.log(`Queued final:`, result.queuedFinal);

  console.log("\n─── Checks ───\n");
  const counts = result.counts as Record<string, number> | undefined;
  const checks = [
    ["modelSelected === \"gpt-4o\"", process.env.LITE_GATEWAY_MODEL === "gpt-4o"],
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

async function cmdStart(): Promise<void> {
  try {
    await startGateway();
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

async function cmdStop(): Promise<void> {
  await stopGateway();
  console.log("[lite-gateway] Stopped");
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
      console.log(`  ${c.id}  ${c.status}  uptime: ${uptime}`);
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
        console.log("No channels in config. Use: lite-gateway channels add --channel <id> [--<key> <value> ...]");
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
  const cfg = loadConfig();
  const chCfg = cfg?.channels?.[channelId];
  if (!chCfg) {
    console.error(`Channel "${channelId}" not found in config`);
    process.exit(1);
  }
  await startChannel(channelId, { ...chCfg, enabled: true });
  console.log(`[lite-gateway] ${channelId} started`);
}

async function cmdChannelsStop(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  if (!channelId) {
    console.error("Missing --channel <id>");
    process.exit(1);
  }
  await stopChannel(channelId);
  console.log(`[lite-gateway] ${channelId} stopped`);
}

async function cmdChannelsRestart(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  if (!channelId) {
    console.error("Missing --channel <id>");
    process.exit(1);
  }
  await ensurePluginsLoaded();
  const cfg = loadConfig();
  const chCfg = cfg?.channels?.[channelId];
  if (!chCfg) {
    console.error(`Channel "${channelId}" not found in config`);
    process.exit(1);
  }
  await restartChannel(channelId, { ...chCfg, enabled: true });
  console.log(`[lite-gateway] ${channelId} restarted`);
}

async function cmdChannelsAdd(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  const token = (args["token"] as string) ?? "";
  if (!channelId) {
    console.error(
      "Usage: lite-gateway channels add --channel <id> [--token <token>] [--<key> <value> ...]",
    );
    process.exit(1);
  }
  // Collect extra plugin-specific fields (appId, clientSecret, etc.)
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k !== "channel" && k !== "token") extra[k] = v;
  }
  addChannel(channelId, token, extra);
  console.log(`[lite-gateway] Channel "${channelId}" added`);
}

async function cmdChannelsRemove(args: Args): Promise<void> {
  const channelId = args["channel"] as string;
  if (!channelId) {
    console.error("Missing --channel <id>");
    process.exit(1);
  }
  removeChannel(channelId);
  console.log(`[lite-gateway] Channel "${channelId}" removed`);
}

// ── Plugins ──────────────────────────────────────────────────────────────

async function cmdPluginsInstall(pkg: string): Promise<void> {
  if (!pkg) {
    console.error("Usage: lite-gateway plugins install <package>");
    console.error("Example: lite-gateway plugins install @openclaw/qqbot");
    process.exit(1);
  }
  console.log(`[lite-gateway] Installing ${pkg}...`);
  const { execSync } = await import("node:child_process");
  const { dirname } = await import("node:path");
  const cwd = dirname(resolveConfigPath()) || ".";
  try {
    execSync(`npm install ${pkg}`, { cwd, stdio: "inherit" });
    console.log(`[lite-gateway] ${pkg} installed.`);
  } catch {
    console.error(`[lite-gateway] Failed to install ${pkg}`);
    process.exit(1);
  }

  // Try to discover and load the newly installed plugin
  const external = discoverExternalPlugins();
  const newPlugin = external.find((p) => pkg.includes(p.id));
  if (newPlugin) {
    const loaded = await loadChannelPlugin(newPlugin);
    if (loaded) {
      console.log(
        `[lite-gateway] Plugin "${newPlugin.id}" ready. ` +
          `Add with: lite-gateway channels add --channel ${newPlugin.id} [--<key> <value> ...]`,
      );
    } else {
      console.log(
        `[lite-gateway] Plugin "${newPlugin.id}" found but could not be loaded. Check compatibility.`,
      );
    }
  } else {
    console.log(
      `[lite-gateway] Installed but no channel metadata found for ${pkg}. ` +
        `Check the package has "openclaw.channel" in package.json.`,
    );
  }
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
    console.log("  Install: lite-gateway plugins install @openclaw/qqbot");
  } else {
    for (const p of external) {
      const status = loaded.includes(p.id) ? "loaded" : "available";
      console.log(`  ${p.id}  [${status}]  ${p.label}`);
    }
  }

  console.log("");
  console.log("To add a channel: lite-gateway channels add --channel <id> [--<key> <value> ...]");
}

// ── Main dispatch ─────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const { command, args } = parseArgs(process.argv);

  // Flags-only invocations: --help, --version before positional dispatch
  if (args["help"] || args["h"]) return printHelp();
  if (args["version"] || args["v"]) {
    console.log(`lite-gateway v${VERSION}`);
    return;
  }

  // Top-level commands
  if (!command || command === "help") return printHelp();
  if (command === "start") return cmdStart();
  if (command === "version") { console.log(`lite-gateway v${VERSION}`); return; }

  switch (command) {
    case "stop": return cmdStop();
    case "restart": return cmdRestart();
    case "status": return cmdStatus(args);
    case "test": return cmdTest();
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
      console.error("Usage: lite-gateway plugins install <package>");
      process.exit(1);
    }
    console.log("Usage: lite-gateway plugins <install|list>");
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
      default:
        // `lite-gateway channels` with no subcommand
        console.log("Usage: lite-gateway channels <subcommand>");
        console.log("  list, status, start, stop, restart, add, remove");
        console.log("  lite-gateway channels --help  for details");
        process.exit(1);
    }
  }

  // Unknown
  console.error(`Unknown command: ${command}`);
  console.error("Use lite-gateway --help");
  process.exit(1);
}

run().catch((err) => {
  console.error("[lite-gateway] Fatal:", (err as Error).message);
  process.exit(1);
});
