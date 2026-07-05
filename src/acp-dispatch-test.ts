import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "ocg-acp-test-"));
const mockPath = join(tempDir, "mock-acp.cjs");

writeFileSync(mockPath, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let sessionId = "session-1";
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1 } });
  } else if (req.method === "session/new") {
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId } });
  } else if (req.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", type: "text", text: "Hello" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " ACP" } } } });
    send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  }
});
`, "utf8");

try {
  const { dispatchReplyWithBufferedBlockDispatcher } = await import("./shims/reply-dispatch-runtime.js");

  const collectedBlocks: string[] = [];
  let finalText = "";

  const result = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: {
      Body: "Ping",
      BodyForAgent: "Ping",
      From: "telegram:12345",
      SessionKey: "telegram:default:12345",
    },
    cfg: {
      liteGateway: {
        agentType: "acp",
        model: "mock-acp",
        acp: {
          command: process.execPath,
          args: [mockPath],
          cwd: process.cwd(),
        },
      },
    },
    dispatcherOptions: {
      deliver: async (payload: Record<string, unknown>, meta: Record<string, unknown>) => {
        if (meta.kind === "block") collectedBlocks.push(String(payload.text ?? ""));
        if (meta.kind === "final") finalText = String(payload.text ?? "");
      },
    },
  });

  const checks = [
    collectedBlocks.join("") === "Hello ACP",
    finalText === "Hello ACP",
    result.queuedFinal === true,
    (result.counts as Record<string, number>).block === 2,
    (result.counts as Record<string, number>).final === 1,
  ];

  console.log("ACP collected blocks:", collectedBlocks);
  console.log("ACP final text:", finalText);
  console.log("ACP result:", result);

  if (!checks.every(Boolean)) {
    console.error("ACP dispatch test failed", checks);
    process.exit(1);
  }

  console.log("ACP dispatch test passed");
} finally {
  const { stopAllAcpAgents } = await import("./acp-agent.js");
  stopAllAcpAgents();
  rmSync(tempDir, { recursive: true, force: true });
}
