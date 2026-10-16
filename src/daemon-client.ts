/**
 * CLI-side HTTP client for the daemon (OCG 1.3.0).
 *
 * Discovers the daemon endpoint (OCG_DAEMON_URL → `ocg-state.json` →
 * config `callbackPort` → 127.0.0.1:3457), attaches the local token and maps
 * transport/auth failures to the uniform `{ok:false, code, message, hint}`
 * shape the CLI renders (§5.7).
 */

import { loadConfig } from "./config.js";
import { readLocalToken } from "./local-auth.js";
import { readGatewayProcessState } from "./process-state.js";

export const DEFAULT_DAEMON_PORT = 3457;
export const DEFAULT_DAEMON_HOST = "127.0.0.1";

export type DaemonEndpoint = {
  baseUrl: string;
  host: string;
  port: number;
  token: string | null;
  source: "env" | "state" | "config" | "default";
};

/** Map a bind host to a host the local CLI can actually connect to. */
function reachableHost(host: string | undefined | null): string {
  if (!host) return DEFAULT_DAEMON_HOST;
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return DEFAULT_DAEMON_HOST;
  return host;
}

export function resolveDaemonEndpoint(): DaemonEndpoint {
  const token = readLocalToken();

  const envUrl = process.env.OCG_DAEMON_URL?.trim();
  if (envUrl) {
    try {
      const url = new URL(envUrl);
      const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
      return { baseUrl: `${url.protocol}//${url.host}`, host: url.hostname, port, token, source: "env" };
    } catch {
      // Malformed override — fall through to state/config discovery.
    }
  }

  const state = readGatewayProcessState();
  if (state?.callbackPort) {
    const host = reachableHost(state.callbackHost);
    return {
      baseUrl: `http://${host}:${state.callbackPort}`,
      host,
      port: state.callbackPort,
      token,
      source: "state",
    };
  }

  const raw = loadConfig();
  if (raw?.callbackPort) {
    const host = reachableHost(raw.callbackHost);
    return { baseUrl: `http://${host}:${raw.callbackPort}`, host, port: raw.callbackPort, token, source: "config" };
  }

  return {
    baseUrl: `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`,
    host: DEFAULT_DAEMON_HOST,
    port: DEFAULT_DAEMON_PORT,
    token,
    source: "default",
  };
}

export type DaemonResponse =
  | { ok: true; status: number; body: Record<string, unknown> }
  | {
      ok: false;
      code: string;
      message: string;
      hint?: string;
      status?: number;
      body?: Record<string, unknown>;
    };

/**
 * One request against the daemon. Never throws: transport and auth failures
 * come back as `{ok:false}` with a stable `code`.
 */
export async function daemonRequest(
  endpoint: DaemonEndpoint,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; timeoutMs?: number } = {},
): Promise<DaemonResponse> {
  const headers: Record<string, string> = { connection: "close" };
  if (endpoint.token) headers["X-OCG-Local-Token"] = endpoint.token;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${endpoint.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (err) {
    return {
      ok: false,
      code: "DAEMON_NOT_RUNNING",
      message: `cannot reach the daemon at ${endpoint.baseUrl} (${(err as Error).message})`,
      hint: "run: ocg daemon start",
    };
  }

  const text = (await response.text()).trim();
  let body: Record<string, unknown> | undefined;
  try {
    body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    if (response.status === 401) {
      return {
        ok: false,
        code: "UNAUTHORIZED",
        status: response.status,
        message: (body?.message as string | undefined) ?? "daemon rejected the local token",
        hint: "restart the daemon to regenerate <configDir>/ocg-local-token",
        ...(body ? { body } : {}),
      };
    }
    return {
      ok: false,
      code: (body?.code as string | undefined) ?? "HTTP_ERROR",
      status: response.status,
      message: (body?.message as string | undefined) ?? (text || `daemon returned HTTP ${response.status}`),
      ...(body?.hint ? { hint: body.hint as string } : {}),
      ...(body ? { body } : {}),
    };
  }

  return { ok: true, status: response.status, body: body ?? {} };
}

/** GET /ocg/health; returns the body when the daemon answers with ok:true. */
export async function probeDaemonHealth(
  endpoint: DaemonEndpoint,
  timeoutMs = 2500,
): Promise<Record<string, unknown> | null> {
  const response = await daemonRequest(endpoint, "GET", "/ocg/health", { timeoutMs });
  if (response.ok && response.body.ok === true) return response.body;
  return null;
}
