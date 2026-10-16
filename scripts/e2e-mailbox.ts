/**
 * End-to-end test: mailbox daemon routes + real CLI processes (OCG 1.3.0).
 *
 * Starts an in-process "daemon" (callback server with the default agent route
 * context) against a temporary config dir, then drives the real CLI as child
 * processes: `inbox wait` (blocked, woken by an enqueue), `reply`, `inbox
 * list`, `inbox ack`, `targets list`, `daemon status`, `doctor`.
 *
 * Run: npx tsx scripts/e2e-mailbox.ts   (from the repo root)
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCallbackServer, stopCallbackServer } from "../src/callback-server.js";
import { buildOpenClawConfig, loadConfig, type LiteGatewayConfig } from "../src/config.js";
import { dispatchInbound } from "../src/inbound.js";
import { ensureLocalToken } from "../src/local-auth.js";
import { resetMailbox } from "../src/mailbox.js";
import { writeGatewayProcessState } from "../src/process-state.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CliResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args],
      { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function parseJson<T = Record<string, unknown>>(output: string): T | null {
  const start = output.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start)) as T;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "ocg-e2e-"));
  const configPath = join(tempDir, "ocg.json");
  process.env.OCG_CONFIG_PATH = configPath;
  writeFileSync(
    configPath,
    JSON.stringify({ agentType: "mailbox", channels: { mock: { enabled: true } } }),
    "utf8",
  );

  ensureLocalToken();
  const port = await startCallbackServer("127.0.0.1", 0, undefined, {});
  writeGatewayProcessState(loadConfig() ?? {}, [], { port, host: "127.0.0.1" });
  const env = {
    OCG_CONFIG_PATH: configPath,
    OCG_DAEMON_URL: `http://127.0.0.1:${port}`,
  };
  console.log(`[e2e] daemon on http://127.0.0.1:${port}, config ${configPath}`);

  const cfg = buildOpenClawConfig(loadConfig() as LiteGatewayConfig);

  // ── 1. inbox wait blocked → woken by a real dispatch enqueue ─────────────
  console.log("\n─── 1. inbox wait ← dispatchInbound enqueue ───");
  const delivered: string[] = [];
  const waitPromise = runCli(["inbox", "wait", "--timeout", "15", "--json", "--consumer", "e2e-1"], env);
  await sleep(900);
  const dispatchResult = await dispatchInbound({
    ctx: {
      Body: "ping from e2e",
      BodyForAgent: "ping from e2e",
      From: "mock:c2c:peer1",
      SessionKey: "mock:agent:main:main",
      MessageSid: "e2e-1",
      ChatType: "direct",
    },
    cfg,
    deliver: async (payload) => {
      delivered.push(String(payload.text));
    },
  });
  const waitResult = await waitPromise;
  const waitBody = parseJson<{ ok: boolean; messages: Array<Record<string, unknown>> }>(waitResult.stdout);
  check("wait exited 0", waitResult.code === 0, { code: waitResult.code, stderr: waitResult.stderr.slice(0, 400) });
  check("wait returned the message", waitBody?.ok === true && waitBody.messages.length === 1, waitBody);
  const messageId = String(waitBody?.messages[0]?.id);
  check("message id matches dispatch", messageId === String(dispatchResult.messageId), { messageId, dispatchResult });

  // ── 2. reply through the reply handle ────────────────────────────────────
  console.log("\n─── 2. reply (handle path) ───");
  const replyResult = await runCli(
    ["reply", messageId, "--text", "pong from e2e", "--json", "--consumer", "e2e-1"],
    env,
  );
  const replyBody = parseJson<{ ok: boolean; via: string }>(replyResult.stdout);
  check("reply exited 0", replyResult.code === 0, { code: replyResult.code, stderr: replyResult.stderr.slice(0, 400) });
  check("reply via=reply", replyBody?.ok === true && replyBody.via === "reply", replyBody);
  check("daemon-side deliver received the text", delivered.join("") === "pong from e2e", delivered);

  // ── 3. list done ────────────────────────────────────────────────────────
  console.log("\n─── 3. inbox list --state done ───");
  const listResult = await runCli(["inbox", "list", "--state", "done", "--json"], env);
  const listBody = parseJson<{ entries: Array<Record<string, unknown>> }>(listResult.stdout);
  check("done list contains the replied message", (listBody?.entries ?? []).some((entry) => entry.id === messageId), listBody);

  // ── 4. second message → inbox ack ───────────────────────────────────────
  console.log("\n─── 4. inbox ack ───");
  const second = await dispatchInbound({
    ctx: { Body: "ack me", From: "mock:c2c:peer1", SessionKey: "mock:agent:main:main" },
    cfg,
  });
  const ackResult = await runCli(["inbox", "ack", String(second.messageId), "--json"], env);
  const ackBody = parseJson<{ ok: boolean; state: string }>(ackResult.stdout);
  check("ack exited 0 and done", ackResult.code === 0 && ackBody?.ok === true && ackBody.state === "done", { code: ackResult.code, ackBody });

  // ── 5. targets ──────────────────────────────────────────────────────────
  console.log("\n─── 5. targets list ───");
  const targetsResult = await runCli(["targets", "list", "--json"], env);
  const targetsBody = parseJson<{ targets: Array<Record<string, unknown>> }>(targetsResult.stdout);
  check(
    "targets include the peer",
    (targetsBody?.targets ?? []).some((target) => target.target === "mock:c2c:peer1"),
    targetsBody,
  );

  // ── 6. daemon status ────────────────────────────────────────────────────
  console.log("\n─── 6. daemon status ───");
  const statusResult = await runCli(["daemon", "status", "--json"], env);
  const statusBody = parseJson<{ ok: boolean; reachable: boolean }>(statusResult.stdout);
  check("daemon status ok", statusResult.code === 0 && statusBody?.ok === true && statusBody.reachable === true, statusBody);

  // ── 7. wait timeout → empty, exit 0 ─────────────────────────────────────
  console.log("\n─── 7. inbox wait timeout ───");
  const emptyResult = await runCli(["inbox", "wait", "--timeout", "1", "--json"], env);
  const emptyBody = parseJson<{ ok: boolean; messages: unknown[] }>(emptyResult.stdout);
  check("timeout exits 0 with empty list", emptyResult.code === 0 && emptyBody?.ok === true && emptyBody.messages.length === 0, emptyBody);

  // ── 8. doctor (channels are not actually running — only partial checks) ──
  console.log("\n─── 8. doctor ───");
  const doctorResult = await runCli(["doctor", "--json"], env);
  const doctorBody = parseJson<{ ok: boolean; checks: Array<Record<string, unknown>> }>(doctorResult.stdout);
  const byName = (name: string): Record<string, unknown> | undefined =>
    (doctorBody?.checks ?? []).find((entry) => entry.name === name);
  check("doctor health check ok", byName("/ocg/health reachable")?.ok === true, byName("/ocg/health reachable"));
  check("doctor mailbox check ok", byName('mailbox mode (agentType: "mailbox")')?.ok === true);
  check("doctor flags channels not running (exit 1)", doctorResult.code === 1, { code: doctorResult.code });

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await stopCallbackServer();
  resetMailbox();
  rmSync(tempDir, { recursive: true, force: true });

  console.log("");
  if (failures === 0) {
    console.log("✅ e2e mailbox test passed!\n");
    process.exitCode = 0;
  } else {
    console.log(`❌ ${failures} e2e check(s) failed!\n`);
    process.exitCode = 1;
  }
}

await main();
