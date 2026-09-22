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
import { buildOpenClawConfig, loadConfig, resolveSendSettings, type SendSettings } from "./config.js";
import { executeSend, type SendRequest } from "./send-service.js";
import type { ChannelPluginObject } from "./plugin-loader.js";
import { ensureChannelPluginLoaded, getChannelPlugin } from "./plugin-loader.js";

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

/**
 * Read a request body with a hard size cap.
 *
 * Oversized bodies are drained (not destroyed) so the 413 response can still be
 * delivered on the same connection. Rejects with `code: "PAYLOAD_TOO_LARGE"`.
 */
async function readBodyLimited(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      if (!oversized) chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) {
        const err = new Error(`request body exceeds ${limit} bytes`) as NodeJS.ErrnoException;
        err.code = "PAYLOAD_TOO_LARGE";
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => reject(err));
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

// ── Proactive send route (POST /ocg/send) ──────────────────────────────────

/**
 * Injection seam for the send route: production reads config + the plugin
 * registry; tests supply fixtures.
 */
export type SendRouteContext = {
  getSettings: () => SendSettings;
  getConfig: () => Record<string, unknown>;
  getPlugin?: (channelId: string) => ChannelPluginObject | null;
  loadPlugin?: (channelId: string) => Promise<ChannelPluginObject | null>;
};

function defaultSendRouteContext(): SendRouteContext {
  return {
    getSettings: () => resolveSendSettings(loadConfig()),
    getConfig: () => buildOpenClawConfig(loadConfig() ?? {}),
    getPlugin: getChannelPlugin,
    loadPlugin: ensureChannelPluginLoaded,
  };
}

/**
 * Handle `POST /ocg/send`.
 *
 * Auth is deliberately first-class: with no configured secret the endpoint
 * answers `403 DISABLED` (a sandbox-local port must never relay messages for
 * unauthenticated callers), and with a secret the raw body must carry a valid
 * `X-OCG-Signature` HMAC.
 */
async function handleSendRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SendRouteContext,
): Promise<void> {
  let settings: SendSettings;
  try {
    settings = ctx.getSettings();
  } catch (err) {
    jsonBody(res, 500, { ok: false, code: "INTERNAL_ERROR", message: (err as Error).message });
    return;
  }

  if (!settings.enabled) {
    jsonBody(res, 403, {
      ok: false,
      code: "DISABLED",
      message: "proactive send is disabled: configure sendSecret or callbackSecret to enable it",
    });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readBodyLimited(req, settings.maxBodyBytes);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PAYLOAD_TOO_LARGE") {
      jsonBody(res, 413, {
        ok: false,
        code: "PAYLOAD_TOO_LARGE",
        message: (err as Error).message,
      });
      return;
    }
    jsonBody(res, 400, { ok: false, code: "INVALID_REQUEST", message: (err as Error).message });
    return;
  }

  if (settings.secret && !verifyHmac(rawBody, req.headers["x-ocg-signature"] as string | undefined, settings.secret)) {
    console.warn("[ocg] send HMAC verification failed");
    jsonBody(res, 401, {
      ok: false,
      code: "BAD_SIGNATURE",
      message: "signature verification failed",
    });
    return;
  }

  let request: SendRequest;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    request = parsed as SendRequest;
  } catch (err) {
    jsonBody(res, 400, { ok: false, code: "INVALID_REQUEST", message: (err as Error).message });
    return;
  }

  try {
    const outcome = await executeSend({
      cfg: ctx.getConfig(),
      settings,
      request,
      deps: {
        ...(ctx.getPlugin ? { getPlugin: ctx.getPlugin } : {}),
        ...(ctx.loadPlugin ? { loadPlugin: ctx.loadPlugin } : {}),
      },
    });
    jsonBody(res, outcome.httpStatus, outcome.body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ocg] send error: ${msg}`);
    jsonBody(res, 500, { ok: false, code: "INTERNAL_ERROR", message: msg });
  }
}

/**
 * Start the callback HTTP server.
 *
 * @param host - bind address (default "127.0.0.1")
 * @param port - bind port (default 3457)
 * @param secret - optional HMAC shared secret for signature verification
 * @param options.send - injection seam for the `/ocg/send` route (tests)
 * @returns the bound port number
 */
export async function startCallbackServer(
  host: string,
  port: number,
  secret?: string,
  options: { send?: SendRouteContext } = {},
): Promise<number> {
  if (server) {
    console.warn("[ocg] callback server already running");
    return _boundPort;
  }

  _callbackSecret = secret ?? null;
  const sendCtx = options.send ?? defaultSendRouteContext();

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

    const url = req.url ?? "/";

    // Route: POST /ocg/send (proactive send)
    if (req.method === "POST" && /^\/ocg\/send(?:\?.*)?$/.test(url)) {
      await handleSendRequest(req, res, sendCtx);
      return;
    }

    // Route: POST /ocg/callback/{token}
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
      try {
        const sendSettings = sendCtx.getSettings();
        if (sendSettings.enabled) {
          const scope = sendSettings.allowedChannels
            ? `channels: ${sendSettings.allowedChannels.join(", ")}`
            : "all configured channels";
          console.log(`[ocg] Proactive send enabled on POST /ocg/send (${scope})`);
        } else {
          console.log("[ocg] Proactive send disabled (set sendSecret or callbackSecret to enable)");
        }
      } catch {
        // Settings are advisory at startup; the route re-resolves them per request.
      }
      resolve(_boundPort);
    });
  });
}

/**
 * Stop the callback server.
 *
 * Closes idle keep-alive connections explicitly (an HTTP client that talks to
 * `/ocg/send` may hold a socket open indefinitely) and falls back to a short
 * timer so shutdown can never hang the CLI / gateway.
 */
export async function stopCallbackServer(): Promise<void> {
  if (!server) return;
  const instance = server;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      server = null;
      _boundPort = 0;
      resolve();
    };
    instance.close(() => finish());
    instance.closeAllConnections?.();
    setTimeout(finish, 3000).unref?.();
  });
}

/** Check if callback server is running */
export function isCallbackServerRunning(): boolean {
  return server !== null && server.listening;
}
