/**
 * Regression test for the callback URL advertised in async dispatch.
 *
 * The gateway often listens on a local port (3457) while agents reach it
 * through a proxy on another port (8080). `X-OCG-Callback` must use the
 * advertised public port; the local bound port is only a last-resort fallback.
 *
 * Run: npx tsx src/callback-url-test.ts
 */

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildOpenClawConfig } from "./config.js";
import { dispatchInbound } from "./inbound.js";
import { getCallbackPort, startCallbackServer, stopCallbackServer } from "./callback-server.js";
import { ensureCallbackServer } from "./gateway.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n─── ${title} ───`);
}

// ── Mock agent: captures the X-OCG-Callback header ──────────────────────────

let capturedCallback: string | null = null;
let captureResolvers: Array<() => void> = [];

const agent = http.createServer((req, res) => {
  if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }
  capturedCallback = (req.headers["x-ocg-callback"] as string | undefined) ?? null;
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [] }));
    const resolvers = captureResolvers;
    captureResolvers = [];
    for (const resolve of resolvers) resolve();
  });
});

await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", resolve));
const agentPort = (agent.address() as { port: number }).port;

function nextCapture(): Promise<void> {
  return new Promise((resolve) => captureResolvers.push(resolve));
}

async function dispatchWith(liteGateway: Record<string, unknown>): Promise<void> {
  const captured = nextCapture();
  await dispatchInbound({
    ctx: {
      Body: "hello",
      From: "openclaw-weixin:direct:user",
      SessionKey: "openclaw-weixin:direct:user",
    },
    cfg: {
      liteGateway: {
        async: true,
        agentType: "http",
        agentUrl: `http://127.0.0.1:${agentPort}/v1/chat/completions`,
        ...liteGateway,
      },
    },
    deliver: async () => undefined,
  });
  await captured;
}

// The local listener uses an ephemeral port so it differs from the advertised
// public port — exactly the sandbox deployment shape that used to break.
await startCallbackServer("127.0.0.1", 0, undefined);
const localCallbackPort = getCallbackPort();

section("buildOpenClawConfig keeps the public callback address");
const built = buildOpenClawConfig({
  agentUrl: `http://127.0.0.1:${agentPort}/v1/chat/completions`,
  async: true,
  callbackHost: "127.0.0.1",
  callbackPort: 3457,
  callbackPublicHost: "10.0.65.110",
  callbackPublicPort: 8080,
});
const lite = built.liteGateway as Record<string, unknown>;
check("callbackPublicHost preserved", lite.callbackPublicHost === "10.0.65.110", lite.callbackPublicHost);
check("callbackPublicPort preserved", lite.callbackPublicPort === 8080, lite.callbackPublicPort);

section("async dispatch advertises the public port");
await dispatchWith({
  callbackHost: "127.0.0.1",
  callbackPort: 3457,
  callbackPublicHost: "10.0.65.110",
  callbackPublicPort: 8080,
  callbackTokenTTL: 5,
});
check(
  "uses callbackPublicHost + callbackPublicPort",
  capturedCallback?.startsWith("http://10.0.65.110:8080/ocg/callback/") ?? false,
  capturedCallback,
);
check(
  "does not leak the local bound port",
  capturedCallback !== null && !capturedCallback.includes(`:${localCallbackPort}/`),
  { capturedCallback, localCallbackPort },
);
check("local bound port really differs from 8080", localCallbackPort !== 8080, localCallbackPort);

section("async dispatch falls back to the configured port");
await dispatchWith({
  callbackHost: "127.0.0.1",
  callbackPort: 8080,
  callbackTokenTTL: 5,
});
check(
  "uses callbackPort when callbackPublicPort is absent",
  capturedCallback?.startsWith("http://127.0.0.1:8080/ocg/callback/") ?? false,
  capturedCallback,
);

section("async mode refuses to run without the callback server");
const tempHome = mkdtempSync(join(tmpdir(), "ocg-callback-test-"));
const previousConfigPath = process.env.OCG_CONFIG_PATH;
process.env.OCG_CONFIG_PATH = join(tempHome, "ocg.json");
await stopCallbackServer();

const blocker = http.createServer((_req, res) => res.end());
await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
const blockedPort = (blocker.address() as { port: number }).port;

let asyncError: Error | null = null;
try {
  await ensureCallbackServer({ async: true, callbackHost: "127.0.0.1", callbackPort: blockedPort });
} catch (err) {
  asyncError = err as Error;
}
check("throws in async mode when the port is taken", asyncError !== null, asyncError?.message);

let syncError: Error | null = null;
try {
  await ensureCallbackServer({ async: false, callbackHost: "127.0.0.1", callbackPort: blockedPort });
} catch (err) {
  syncError = err as Error;
}
check("stays non-fatal in sync mode", syncError === null, syncError?.message);

blocker.close();
if (previousConfigPath === undefined) {
  delete process.env.OCG_CONFIG_PATH;
} else {
  process.env.OCG_CONFIG_PATH = previousConfigPath;
}
rmSync(tempHome, { recursive: true, force: true });

agent.close();
await stopCallbackServer();

console.log(`\n${failures === 0 ? "✅ All callback URL tests passed!" : `❌ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
