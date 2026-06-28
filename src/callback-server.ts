/**
 * Callback HTTP server for async dispatch mode.
 *
 * Agent backends POST to /ocg/callback/{token} with the reply body.
 * The token is a URL path segment (standard REST webhook pattern),
 * NOT embedded in the JSON body.
 *
 * Optional HMAC-SHA256 signature verification via X-OCG-Signature header.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deliverPayloadInChunks } from "./reply-chunking.js";

// ── Types ──────────────────────────────────────────────────────────────

/** The payload the agent backend sends to /ocg/callback/{token} */
export interface CallbackPayload {
  /** Reply text (string) or structured content object */
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

/** Auto-cleanup TTL in milliseconds (default 30 minutes) */
const DEFAULT_DELIVER_TTL_MS = 30 * 60_000;

/**
 * Register a deliver function and return a token.
 * The caller uses this token to build the callback URL:
 *   POST /ocg/callback/{token}
 *
 * @param deliver - the delivery function
 * @param ttlMs - token lifetime in milliseconds (default 30 minutes)
 */
export function registerDeliver(deliver: DeliverFn, ttlMs?: number): string {
  const token = randomToken();
  deliverRegistry.set(token, deliver);

  const ttl = ttlMs && ttlMs > 0 ? ttlMs : DEFAULT_DELIVER_TTL_MS;

  setTimeout(() => {
    deliverRegistry.delete(token);
  }, ttl);

  return token;
}

/** Look up and remove a deliver function. Returns undefined if expired. */
export function consumeDeliver(token: string): DeliverFn | undefined {
  const fn = deliverRegistry.get(token);
  deliverRegistry.delete(token);
  return fn;
}

// ── Helpers ────────────────────────────────────────────────────────────

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function jsonBody<T = unknown>(res: ServerResponse, code: number, body: T): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── HMAC verification ──────────────────────────────────────────────────

function verifyHmac(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  // Expected format: sha256=<hex-digest>
  const match = signatureHeader.match(/^sha256=([0-9a-fA-F]{64})$/);
  if (!match) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = Buffer.from(match[1], "hex");
  const expectedBuf = Buffer.from(expected, "hex");

  if (received.length !== expectedBuf.length) return false;
  return timingSafeEqual(received, expectedBuf);
}

// ── Server ─────────────────────────────────────────────────────────────

let server: Server | null = null;
let _boundPort = 0;
let _callbackSecret: string | null = null;

/**
 * Build the full callback URL with embedded token.
 *
 * Used by dispatch shims to construct the X-OCG-Callback header.
 * If `host` is "0.0.0.0", the URL uses "127.0.0.1" so the Agent
 * can actually reach it.
 */
export function buildCallbackUrl(
  host: string,
  port: number,
  token: string,
): string {
  const reachableHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${reachableHost}:${port}/ocg/callback/${token}`;
}

/**
 * Retrieve the HMAC secret used for callback verification (if configured).
 */
export function getCallbackSecret(): string | null {
  return _callbackSecret;
}

/**
 * Retrieve the actual bound port (may differ from requested port=0).
 */
export function getCallbackPort(): number {
  return _boundPort;
}

/**
 * Start the callback HTTP server.
 *
 * @param host - bind address (default "127.0.0.1")
 * @param port - bind port (default 3457)
 * @param secret - optional HMAC shared secret for signature verification
 * @returns the bound port number
 */
export async function startCallbackServer(
  host: string,
  port: number,
  secret?: string,
): Promise<number> {
  if (server) {
    console.warn("[ocg] callback server already running");
    return _boundPort;
  }

  _callbackSecret = secret ?? null;

  server = createServer(async (req, res) => {
    // CORS for agent backends on other ports
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-OCG-Signature");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route: POST /ocg/callback/{token}
    const url = req.url ?? "/";
    const match = url.match(/^\/ocg\/callback\/([a-f0-9]{64})(?:\?.*)?$/);

    if (req.method !== "POST" || !match) {
      if (req.method === "POST" && url === "/ocg/callback") {
        // Backward-compat hint for old agent runtimes
        jsonBody(res, 400, {
          error: "callback token must be in URL path: POST /ocg/callback/{token}",
        });
        return;
      }
      jsonBody(res, 404, { error: "not found" });
      return;
    }

    const token = match[1];

    try {
      const rawBody = await readBody(req);

      // HMAC verification (if secret is configured)
      if (_callbackSecret) {
        const sigHeader = req.headers["x-ocg-signature"] as string | undefined;
        if (!verifyHmac(rawBody, sigHeader, _callbackSecret)) {
          console.warn("[ocg] callback HMAC verification failed");
          jsonBody(res, 401, { error: "signature verification failed" });
          return;
        }
      }

      const bodyStr = rawBody.toString("utf-8");
      const payload: CallbackPayload = JSON.parse(bodyStr);

      const deliver = consumeDeliver(token);
      if (!deliver) {
        jsonBody(res, 404, { error: "unknown or expired callback token" });
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

      const deliveredChunks = await deliverPayloadInChunks(
        deliver,
        { text, isError: payload.isError ?? false },
        { kind: "final", assistantMessageIndex: 0 },
      );

      console.log(`[ocg] callback delivered (${text.length} chars${deliveredChunks > 1 ? `, ${deliveredChunks} chunks` : ""})`);
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
      _boundPort = typeof addr === "string" ? port : addr?.port ?? port;
      const hmacInfo = _callbackSecret ? " (HMAC enabled)" : "";
      console.log(`[ocg] Callback server listening on http://${host}:${_boundPort}${hmacInfo}`);
      resolve(_boundPort);
    });
  });
}

/** Stop the callback server */
export async function stopCallbackServer(): Promise<void> {
  if (!server) return;
  return new Promise((resolve) => {
    server!.close(() => {
      server = null;
      _boundPort = 0;
      resolve();
    });
  });
}

/** Check if callback server is running */
export function isCallbackServerRunning(): boolean {
  return server !== null && server.listening;
}
