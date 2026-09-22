/**
 * Regression check for the existing callback path after adding /ocg/send:
 * signed callback delivery works, tokens stay single-use, HMAC still enforced.
 * Run: node scripts/callback-regression.mjs  (from repo root, after npm run build)
 */
import { createHmac } from "node:crypto";
import {
  getCallbackPort,
  registerDeliver,
  startCallbackServer,
  stopCallbackServer,
} from "../dist/callback-server.js";

const secret = "regression-secret";
console.log("[regression] starting callback server...");
const port = await startCallbackServer("127.0.0.1", 0, secret);
console.log(`[regression] listening on ${port}`);

const delivered = [];
const token = registerDeliver(async (payload) => {
  delivered.push(payload.text);
});

const body = JSON.stringify({ reply: "hello from agent" });
const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const url = `http://127.0.0.1:${getCallbackPort()}/ocg/callback/${token}`;
const headers = { "X-OCG-Signature": sig, connection: "close" };

console.log("[regression] posting callback...");
const first = await fetch(url, { method: "POST", headers, body });
const firstBody = await first.json();
console.log(`[regression] first callback → ${first.status}`);

const second = await fetch(url, { method: "POST", headers, body });
console.log(`[regression] replay → ${second.status}`);

const badToken = registerDeliver(async () => {});
const badSig = await fetch(`http://127.0.0.1:${getCallbackPort()}/ocg/callback/${badToken}`, {
  method: "POST",
  headers: { "X-OCG-Signature": `sha256=${"0".repeat(64)}`, connection: "close" },
  body,
});
console.log(`[regression] bad signature → ${badSig.status}`);

const checks = [
  ["callback delivered (200 ok)", first.status === 200 && firstBody.ok === true],
  ["deliver received the text", delivered[0] === "hello from agent"],
  ["token is single-use (404)", second.status === 404],
  ["bad signature rejected (401)", badSig.status === 401],
  ["bound port reported", port > 0 && getCallbackPort() === port],
];

console.log("[regression] stopping server...");
await stopCallbackServer();
console.log("[regression] stopped");

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed += 1;
}
console.log(failed === 0 ? "\n✅ callback regression passed!\n" : `\n❌ ${failed} check(s) failed\n`);
// Exit explicitly, after a short delay: registerDeliver() schedules a 30-minute
// TTL timer that keeps the event loop alive, and exiting in the same tick as the
// server teardown trips a libuv assertion on Windows.
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 250).unref();
