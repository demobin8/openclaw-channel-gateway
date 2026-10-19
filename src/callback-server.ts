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
import { randomBytes } from "node:crypto";
import { deliverPayloadInChunks } from "./reply-chunking.js";
import { buildOpenClawConfig, loadConfig, resolveSendSettings, type SendSettings } from "./config.js";
import { executeSend, type SendRequest } from "./send-service.js";
import type { ChannelPluginObject } from "./plugin-loader.js";
import { ensureChannelPluginLoaded, getChannelPlugin } from "./plugin-loader.js";
import { jsonBody, readBody, readBodyLimited } from "./http-util.js";
import { isLoopbackAddress, isWildcardHost, localTokenMatches, readLocalToken, verifyHmacSignature } from "./local-auth.js";
import { agentRouteAuthOptions, defaultAgentRouteContext, handleAgentRoutes, type AgentRouteContext } from "./agent-routes.js";

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
 * unauthenticated callers). With a secret the raw body must carry a valid
 * `X-OCG-Signature` HMAC — or, for same-machine CLI callers, the local token
 * (`X-OCG-Local-Token`, loopback only when the server binds a wildcard host;
 * see §5.9). The local token satisfies authentication but does NOT lift the
 * secret requirement: an operator without sendSecret still gets `403 DISABLED`,
 * exactly like the in-process `ocg send`.
 */
async function handleSendRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SendRouteContext,
  auth: { localToken: string | null; localTokenLoopbackOnly: boolean },
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

  // Authentication: a valid local token (loopback only when bound to a
  // wildcard host) OR a valid HMAC signature over the raw body.
  const tokenHeader = req.headers["x-ocg-local-token"];
  const localOk =
    localTokenMatches(auth.localToken, typeof tokenHeader === "string" ? tokenHeader : undefined) &&
    (!auth.localTokenLoopbackOnly || isLoopbackAddress(req.socket?.remoteAddress));
  if (!localOk) {
    const sigHeader = req.headers["x-ocg-signature"] as string | undefined;
    if (!settings.secret || !verifyHmacSignature(rawBody, sigHeader, settings.secret)) {
      console.warn("[ocg] send auth failed (no valid local token or signature)");
      jsonBody(res, 401, {
        ok: false,
        code: "BAD_SIGNATURE",
        message: "signature verification failed",
      });
      return;
    }
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
 * Routes (see techdesign §5.6):
 *   POST /ocg/callback/{token}    reply delivery for async dispatch
 *   POST /ocg/send                proactive send (HMAC or local token)
 *   GET  /ocg/health              daemon liveness / capabilities
 *   GET  /ocg/inbox[/wait|/{id}]  mailbox pull routes (local token or HMAC)
 *   POST /ocg/inbox/{id}/ack|reply
 *   GET  /ocg/targets
 *
 * @param host - bind address (default "127.0.0.1")
 * @param port - bind port (default 3457)
 * @param secret - optional HMAC shared secret for signature verification
 * @param options.send  - injection seam for the `/ocg/send` route (tests)
 * @param options.agent - injection seam for the agent routes (tests)
 * @param options.localToken - override the local token (null disables local
 *        token auth; undefined → read the token file next to ocg.json)
 * @returns the bound port number
 */
export async function startCallbackServer(
  host: string,
  port: number,
  secret?: string,
  options: { send?: SendRouteContext; agent?: AgentRouteContext; localToken?: string | null } = {},
): Promise<number> {
  if (server) {
    console.warn("[ocg] callback server already running");
    return _boundPort;
  }

  _callbackSecret = secret ?? null;
  const sendCtx = options.send ?? defaultSendRouteContext();
  const agentCtx = options.agent ?? defaultAgentRouteContext();
  const authOptions = agentRouteAuthOptions(agentCtx, isWildcardHost(host));
  if (options.localToken !== undefined) authOptions.localToken = options.localToken;

  server = createServer(async (req, res) => {
    // CORS for agent backends on other ports / hosts
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-OCG-Signature, X-OCG-Local-Token");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const rawUrl = req.url ?? "/";
    let requestUrl: URL;
    try {
      requestUrl = new URL(rawUrl, "http://localhost");
    } catch {
      jsonBody(res, 400, { error: "malformed request URL" });
      return;
    }
    const pathname = requestUrl.pathname;

    // Route: POST /ocg/send (proactive send)
    if (req.method === "POST" && pathname === "/ocg/send") {
      await handleSendRequest(req, res, sendCtx, {
        localToken: authOptions.localToken,
        localTokenLoopbackOnly: authOptions.localTokenLoopbackOnly,
      });
      return;
    }

    // Routes: /ocg/health, /ocg/inbox*, /ocg/targets (agent CLI surface)
    if (await handleAgentRoutes(req, res, requestUrl, agentCtx, authOptions)) {
      return;
    }

    // Route: POST /ocg/callback/{token}
    const match = pathname.match(/^\/ocg\/callback\/([a-f0-9]{64})$/);

    if (req.method !== "POST" || !match) {
      if (req.method === "POST" && pathname === "/ocg/callback") {
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
        if (!verifyHmacSignature(rawBody, sigHeader, _callbackSecret)) {
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
      // A bind failure must not leave a non-listening server behind: the next
      // start attempt would otherwise short-circuit on `if (server)` and the
      // caller would believe the callback route is available.
      if (!server?.listening) {
        server = null;
        _boundPort = 0;
      }
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
      try {
        if (agentCtx.isMailboxEnabled()) {
          const stats = agentCtx.getMailbox().stats();
          console.log(
            `[ocg] Mailbox mode enabled — pull messages with "ocg inbox wait" (pending: ${stats.pending})`,
          );
        }
      } catch {
        // Mailbox is advisory at startup too.
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
