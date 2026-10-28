/**
 * Ingress authorization smoke test: channel-level dmPolicy/allowFrom and
 * groupPolicy/allowedGroups are enforced before any transport sees a message.
 */
import assert from "node:assert/strict";
import { isInboundAuthorized } from "./inbound.js";

function message(overrides: Record<string, unknown> = {}) {
  return {
    chatType: "direct" as const,
    sender: { id: "u1", name: null },
    target: "u1",
    sessionKey: "agent:main:wx:direct:u1",
    ...overrides,
  };
}

const cfg = {
  channels: {
    wx: { dmPolicy: "allowlist", allowFrom: ["u1"] },
    open: { dmPolicy: "open" },
    pair: { dmPolicy: "pairing", allowFrom: ["u1"] },
    group: { groupPolicy: "allowlist", allowedGroups: ["g1"] },
  },
};

assert.equal(isInboundAuthorized(cfg, "open", message({ sender: { id: "stranger", name: null }, target: "stranger" })).allowed, true);
assert.equal(isInboundAuthorized(cfg, "wx", message()).allowed, true);
assert.equal(
  isInboundAuthorized(cfg, "wx", message({ sender: { id: "stranger", name: null }, target: "stranger" })).allowed,
  false,
);
assert.equal(isInboundAuthorized(cfg, "wx", message({ sender: { id: null, name: null } })).allowed, true);
assert.equal(
  isInboundAuthorized(cfg, "wx", message({ sender: { id: "u2", name: null }, target: "u2" })).allowed,
  false,
);
assert.equal(isInboundAuthorized(cfg, "pair", message()).allowed, true);
assert.equal(
  isInboundAuthorized(cfg, "pair", message({ sender: { id: "u2", name: null }, target: "u2" })).allowed,
  false,
);
assert.equal(isInboundAuthorized(cfg, "group", message({ chatType: "group", target: "g1" })).allowed, true);
assert.equal(isInboundAuthorized(cfg, "group", message({ chatType: "group", target: "g2" })).allowed, false);
assert.equal(isInboundAuthorized(cfg, "missing", message()).allowed, true);
assert.equal(
  isInboundAuthorized({ channels: { wx: { dmPolicy: "allowlist", allowFrom: ["*"] } } }, "wx", message()).allowed,
  true,
);

console.log("✅ inbound authorization tests passed");
