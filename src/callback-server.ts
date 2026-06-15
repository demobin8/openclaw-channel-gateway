/**
 * Callback HTTP server for async dispatch mode.
 *
 * Agent backends POST to /ocg/callback with the reply, and this server
 * looks up the stored {@link DeliverFn} and delivers the message to the
 * channel plugin.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

// ── Types ──────────────────────────────────────────────────────────────

/** The payload the agent backend sends to /ocg/callback */
export interface CallbackPayload {
  /** Opaque token returned in the forward request so we can find the deliver fn */
  callbackToken: string;
  /** Reply text (or structured content object) */
  reply?: string | Record<string, unknown>;
  /** If true, treat this as an error reply */
  isError?: boolean;
}

/**
 * Deliver function stored per-message.  Matches the shape that channel
 * plugins pass into `dispatcherOptions.deliver`.
 */
export type DeliverFn = (
  payload: Record<string, unknown>,
  meta: Record<string, unknown>,
) => Promise<void>;

// ── Registry ───────────────────────────────────────────────────────────

/** Maps callbackToken → deliver function */
const deliverRegistry = new Map<string, DeliverFn>();

/** Auto-cleanup after 10 minutes */
const DELIVER_TTL_MS = 10 * 60_000;

/**
 * Register a deliver function and return a token that the agent backend
 * can use to call back.
 */
export function registerDeliver(deliver: DeliverFn): string {
  const token = randomToken();
  deliverRegistry.set(token, deliver);

  // Auto-cleanup
  setTimeout(() => {
    deliverRegistry.delete(token);
  }, DELIVER_TTL_MS);

  return token;
}

/** Look up and remove a deliver function */
function consumeDeliver(token: string): DeliverFn | undefined {
  const fn = deliverRegistry.get(token);
  deliverRegistry.delete(token);
  return fn;
}

// ── Helpers ────────────────────────────────────────────────────────────

function randomToken(): string {
  const buf = Buffer.allocUnsafe(16);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = (Math.random() * 256) | 0;
  }
  return buf.toString("hex");
}

function jsonBody<T = unknown>(res: ServerResponse, code: number, body: T): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Server ─────────────────────────────────────────────────────────────

let server: Server | null = null;

/**
 * Start the callback HTTP server.
 * Returns the bound port (may differ from `port` if port was 0).
 */
export async function startCallbackServer(
  host: string,
  port: number,
): Promise<number> {
  if (server) {
    console.warn("[ocg] callback server already running");
    return (server.address() as { port: number }).port;
  }

  server = createServer(async (req, res) => {
    // CORS for agent backends on other ports
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST" || req.url !== "/ocg/callback") {
      jsonBody(res, 404, { error: "not found" });
      return;
    }

    try {
      const raw = await readBody(req);
      const payload: CallbackPayload = JSON.parse(raw);

      if (!payload.callbackToken) {
        jsonBody(res, 400, { error: "missing callbackToken" });
        return;
      }

      const deliver = consumeDeliver(payload.callbackToken);
      if (!deliver) {
        jsonBody(res, 404, { error: "unknown or expired callbackToken" });
        return;
      }

      // Build reply payload — accept both plain string and structured
      let text = "";
      if (typeof payload.reply === "string") {
        text = payload.reply;
      } else if (payload.reply && typeof payload.reply === "object") {
        text = (payload.reply as Record<string, unknown>).text as string
            ?? (payload.reply as Record<string, unknown>).content as string
            ?? JSON.stringify(payload.reply);
      }

      await deliver(
        { text, isError: payload.isError ?? false },
        { kind: "final", assistantMessageIndex: 0 },
      );

      console.log(`[ocg] callback delivered (${text.length} chars)`);
      jsonBody(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ocg] callback error: ${msg}`);
      jsonBody(res, 500, { error: msg });
    }
  });

  return new Promise<number>((resolve, reject) => {
    server!.on("error", (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        reject(new Error(`Port ${port} already in use`));
      } else {
        reject(err);
      }
    });
    server!.listen(port, host, () => {
      const addr = server!.address();
      const boundPort = typeof addr === "string" ? port : addr?.port ?? port;
      console.log(`[ocg] Callback server listening on http://${host}:${boundPort}`);
      resolve(boundPort);
    });
  });
}

/** Stop the callback server */
export async function stopCallbackServer(): Promise<void> {
  if (!server) return;
  return new Promise((resolve) => {
    server!.close(() => {
      server = null;
      resolve();
    });
  });
}

/** Check if callback server is running */
export function isCallbackServerRunning(): boolean {
  return server !== null && server.listening;
}
