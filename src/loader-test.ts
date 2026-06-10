/**
 * Verify that the ESM loader correctly routes:
 * 1. Our shim's own imports → real openclaw package
 * 2. Plugin imports → our shim
 */

console.log("─── Testing ESM loader routing ───\n");

// Test 1: Import our shim's public exports (should include real utilities)
const shim = await import("./shims/reply-dispatch-runtime.js");
console.log("Test 1: Key exports exist on shim module");
console.log("  dispatchReplyWithBufferedBlockDispatcher:", typeof shim.dispatchReplyWithBufferedBlockDispatcher);
console.log("  dispatchReplyWithDispatcher:", typeof shim.dispatchReplyWithDispatcher);
console.log("  resolveChunkMode:", typeof shim.resolveChunkMode);
console.log("  generateConversationLabel:", typeof shim.generateConversationLabel);
console.log("  finalizeInboundContext:", typeof shim.finalizeInboundContext);

// Verify utility functions are real (not undefined)
const checks = [
  ["dispatchReplyWithBufferedBlockDispatcher", typeof shim.dispatchReplyWithBufferedBlockDispatcher === "function"],
  ["dispatchReplyWithDispatcher", typeof shim.dispatchReplyWithDispatcher === "function"],
  ["resolveChunkMode", typeof shim.resolveChunkMode === "function"],
  ["generateConversationLabel", typeof shim.generateConversationLabel === "function"],
  ["finalizeInboundContext", typeof shim.finalizeInboundContext === "function"],
];

let passed = 0;
let failed = 0;
for (const [name, ok] of checks) {
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}: type is ${typeof (shim as any)[name]}`);
    failed++;
  }
}

// Test 2: Call resolveChunkMode with test config
try {
  const mode = shim.resolveChunkMode({}, "telegram", "default");
  console.log(`\n  resolveChunkMode({}, "telegram", "default") → "${mode}"`);
  if (mode === "length") {
    console.log("  ✅ resolveChunkMode works correctly");
    passed++;
  } else {
    console.log(`  ❌ Expected "length", got "${mode}"`);
    failed++;
  }
} catch (err) {
  console.log(`  ❌ resolveChunkMode threw: ${err}`);
  failed++;
}

// Summary
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───`);
if (failed > 0) {
  console.log("❌ Some tests failed!");
  process.exit(1);
} else {
  console.log("✅ All tests passed!");
  process.exit(0);
}
