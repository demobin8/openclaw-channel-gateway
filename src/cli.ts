/**
 * Lite Gateway CLI — mirrors `openclaw channels` command surface.
 *
 * Usage:
 *   ocg start                     启动全部
 *   ocg stop                      停止全部
 *   ocg restart                   重启全部
 *   ocg status                    网关状态
 *   ocg version                   版本
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

const VERSION = "1.0.1";

// ── Helpers ───────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log(
    "╔══════════════════════════════════════╗\n" +
    "║         OCG  v1.0.0                    ║\n" +
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
  console.log("  channels login --channel <id>    QR login (for WeChat, etc.)");
  console.log("  channels add --channel <id> [--account <id>] [--<k> <v> ...]  Add a channel account");
  console.log("  channels remove --channel <id>   Remove a channel");
  console.log("");
  console.log("  plugins install <pkg>            Install a channel plugin (npm install)");
  console.log("  plugins list                     List installed channel plugins");
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
    const cbHost = rawCfg.callbackHost ?? "127.0.0.1";
    const cbPort = rawCfg.callbackPort ?? 3457;
    try {
      await startCallbackServer(cbHost, cbPort);
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
  if (command === "start") return cmdStart();
  if (command === "version") { console.log(`ocg v${VERSION}`); return; }

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
      console.error("Usage: ocg plugins install <package>");
      process.exit(1);
    }
    console.log("Usage: ocg plugins <install|list>");
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
  console.error(`Unknown command: ${command}`);
  console.error("Use ocg --help");
  process.exit(1);
}

run().catch((err) => {
  console.error("[ocg] Fatal:", (err as Error).message);
  process.exit(1);
});
