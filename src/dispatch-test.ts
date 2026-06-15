/**
 * End-to-end smoke test for ocg dispatch pipeline.
 *
 * Starts a local HTTP server that mimics an OpenAI-compatible API,
 * then exercises the `dispatchReplyWithBufferedBlockDispatcher` shim
 * to verify the full request → stream → response pipeline works.
 */

import http from "node:http";

let testPort = 0;
let server: http.Server;

// Test chunks to stream
const CHUNKS = [
  { delta: "Hello" },
  { delta: " from" },
  { delta: " lite" },
  { delta: " gateway!" },
];

// ── Start mock agent server ──────────────────────────────────────────────

const serverStarted = new Promise<void>((resolve) => {
  server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        console.log(`[mock-agent] Received request: model=${parsed.model}, messages=${parsed.messages.length}`);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        // Stream each chunk as an SSE event
        for (const chunk of CHUNKS) {
          const sseData = JSON.stringify({
            id: "test-id",
            object: "chat.completion.chunk",
            created: Date.now(),
            model: parsed.model || "gpt-4o",
            choices: [
              {
                index: 0,
                delta: { content: chunk.delta },
                finish_reason: null,
              },
            ],
          });
          res.write(`data: ${sseData}\n\n`);
        }

        // Send [DONE]
        res.write("data: [DONE]\n\n");
        res.end();
      });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    testPort = addr.port;
    console.log(`[mock-agent] Listening on http://127.0.0.1:${testPort}`);
    resolve();
  });
});

await serverStarted;

// ── Configure dispatch ───────────────────────────────────────────────────

process.env.OCG_AGENT_URL = `http://127.0.0.1:${testPort}/v1/chat/completions`;
process.env.OCG_MODEL = "gpt-4o";

// ── Run dispatch ─────────────────────────────────────────────────────────

console.log("\n─── Testing dispatchReplyWithBufferedBlockDispatcher ───\n");

const { dispatchReplyWithBufferedBlockDispatcher } = await import(
  "./shims/reply-dispatch-runtime.js"
);

const collectedTexts: string[] = [];
let finalText: string | undefined;
let modelSelected: string | undefined;

const result = await dispatchReplyWithBufferedBlockDispatcher({
  ctx: {
    Body: "Hello, how are you?",
    BodyForAgent: "Hello, how are you?",
    From: "telegram:12345",
    SessionKey: "test:session",
  },
  cfg: {},
  dispatcherOptions: {
    onModelSelected: async (model) => {
      modelSelected = model;
    },
    deliver: async (payload, meta) => {
      if (meta.kind === "block") {
        collectedTexts.push(payload.text as string);
      } else if (meta.kind === "final") {
        finalText = payload.text as string;
      }
    },
  },
});

// ── Verify results ───────────────────────────────────────────────────────

console.log("\n─── Results ───\n");
console.log("Model selected:", modelSelected);
console.log("Collected blocks:", collectedTexts);
console.log("Final text:", finalText);
console.log("Result counts:", result.counts);
console.log("Queued final:", result.queuedFinal);

const passed = [
  modelSelected === "gpt-4o",
  collectedTexts.length === CHUNKS.length,
  finalText === "Hello from lite gateway!",
  result.counts.block === CHUNKS.length,
  result.counts.final === 1,
  result.queuedFinal === true,
].every(Boolean);

// Log detail for each check
console.log("\n─── Checks ───\n");
console.log(`  modelSelected === "gpt-4o": ${modelSelected === "gpt-4o"} (got: ${modelSelected})`);
console.log(`  collectedTexts.length === ${CHUNKS.length}: ${collectedTexts.length === CHUNKS.length}`);
console.log(`  finalText === "Hello from lite gateway!": ${finalText === "Hello from lite gateway!"} (got: ${finalText})`);
console.log(`  result.counts.block === ${CHUNKS.length}: ${result.counts.block === CHUNKS.length}`);
console.log(`  result.counts.final === 1: ${result.counts.final === 1}`);
console.log(`  result.queuedFinal === true: ${result.queuedFinal === true}`);

// Cleanup
server.close();

if (passed) {
  console.log("\n✅ All tests passed!\n");
  process.exit(0);
} else {
  console.log("\n❌ Some tests failed!\n");
  process.exit(1);
}
