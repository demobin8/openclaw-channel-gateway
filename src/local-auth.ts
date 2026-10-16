/**
 * Local authentication for the daemon HTTP surface (OCG 1.3.0).
 *
 * The callback server already verifies remote callers with HMAC signatures
 * (`X-OCG-Signature`).  Short-lived CLI commands run on the same machine and
 * must NOT require the operator to configure an HMAC secret just to talk to
 * their own daemon, so the daemon also generates a random **local token** at
 * startup (`ocg-local-token`, next to `ocg.json`) and accepts it in
 * `X-OCG-Local-Token` — from loopback addresses only when the server binds a
 * wildcard host (see docs/techdesign-agent-cli.md §5.9).
 *
 * This module also hosts the shared HMAC verify helper so both the callback
 * route and the agent routes use exactly the same implementation.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfigPath } from "./config.js";

export const LOCAL_TOKEN_FILE = "ocg-local-token";

/** Path of the local token file — next to the config file it belongs to. */
export function resolveLocalTokenPath(): string {
  return join(dirname(resolveConfigPath()), LOCAL_TOKEN_FILE);
}

/**
 * Return the local token, generating one (32 random bytes, hex) when the file
 * does not exist yet.  POSIX permissions are tightened to 0600; on Windows the
 * user-directory ACL is the boundary (documented behaviour).
 */
export function ensureLocalToken(path = resolveLocalTokenPath()): string {
  const existing = readTokenFile(path);
  if (existing) return existing;

  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: Windows does not implement POSIX modes.
  }
  return token;
}

/** Read the local token; null when absent or empty. Never throws. */
export function readLocalToken(path = resolveLocalTokenPath()): string | null {
  return readTokenFile(path);
}

function readTokenFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/** Constant-time comparison that tolerates missing values. */
export function localTokenMatches(expected: string | null, provided: string | undefined | null): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Whether an address is a loopback address (IPv4, IPv6 or IPv4-mapped). */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  let addr = address.trim().toLowerCase();
  if (addr.startsWith("::ffff:")) addr = addr.slice("::ffff:".length);
  if (addr === "::1" || addr === "localhost") return true;
  if (addr.startsWith("127.")) return true;
  return false;
}

/** Whether a bind host listens on every interface. */
export function isWildcardHost(host: string | undefined | null): boolean {
  if (!host) return true;
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/**
 * Verify an HMAC-SHA256 signature header (`sha256=<hex>`) over the raw body.
 * Shared by `/ocg/callback`, `/ocg/send` and the agent routes.
 */
export function verifyHmacSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const match = signatureHeader.match(/^sha256=([0-9a-fA-F]{64})$/);
  if (!match) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = Buffer.from(match[1], "hex");
  const expectedBuf = Buffer.from(expected, "hex");

  if (received.length !== expectedBuf.length) return false;
  return timingSafeEqual(received, expectedBuf);
}

/** Accepted clock skew for timestamped request signatures (5 minutes). */
export const SIGNED_REQUEST_MAX_SKEW_MS = 5 * 60_000;

/**
 * Canonical bytes for a timestamped request signature:
 *
 *   `<unix-seconds>\n<METHOD>\n<path?query>\n` + raw body
 *
 * Binding method, path and time to the signature means a captured
 * `X-OCG-Signature` cannot be replayed against another route or after the
 * skew window — a body-only signature over an empty GET body would otherwise
 * be a permanent bearer token for every read route.
 */
export function buildSignedRequestPayload(
  timestamp: string,
  method: string,
  pathWithQuery: string,
  rawBody: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from(`${timestamp}\n${method.toUpperCase()}\n${pathWithQuery}\n`, "utf8"),
    rawBody,
  ]);
}

/** Produce the `X-OCG-Signature` value for a timestamped request (clients / tests). */
export function signRequest(
  secret: string,
  timestamp: string,
  method: string,
  pathWithQuery: string,
  rawBody: Buffer = Buffer.alloc(0),
): string {
  const digest = createHmac("sha256", secret)
    .update(buildSignedRequestPayload(timestamp, method, pathWithQuery, rawBody))
    .digest("hex");
  return `sha256=${digest}`;
}

export type SignedRequestVerdict =
  | { ok: true; mode: "timestamped" | "body" }
  | { ok: false; reason: "missing" | "bad-signature" | "stale-timestamp" | "timestamp-required" };

/**
 * Verify a request-level HMAC signature.
 *
 * - With `X-OCG-Timestamp` present: the signature must cover
 *   `buildSignedRequestPayload(...)` and the timestamp must be within
 *   {@link SIGNED_REQUEST_MAX_SKEW_MS} of `now`.
 * - Without it: only non-GET requests may fall back to the legacy body-only
 *   signature (what `/ocg/send` has always accepted). GET requests have no
 *   body to bind, so they require the timestamped form.
 */
export function verifySignedRequest(params: {
  secret: string;
  method: string;
  pathWithQuery: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  now?: number;
}): SignedRequestVerdict {
  const { secret, method, pathWithQuery, rawBody, signatureHeader, timestampHeader } = params;
  if (!signatureHeader) return { ok: false, reason: "missing" };

  if (timestampHeader !== undefined && timestampHeader !== "") {
    const seconds = Number(timestampHeader);
    if (!Number.isFinite(seconds)) return { ok: false, reason: "stale-timestamp" };
    const now = params.now ?? Date.now();
    if (Math.abs(now - seconds * 1000) > SIGNED_REQUEST_MAX_SKEW_MS) {
      return { ok: false, reason: "stale-timestamp" };
    }
    const payload = buildSignedRequestPayload(timestampHeader, method, pathWithQuery, rawBody);
    return verifyHmacSignature(payload, signatureHeader, secret)
      ? { ok: true, mode: "timestamped" }
      : { ok: false, reason: "bad-signature" };
  }

  if (method.toUpperCase() === "GET") return { ok: false, reason: "timestamp-required" };
  return verifyHmacSignature(rawBody, signatureHeader, secret)
    ? { ok: true, mode: "body" }
    : { ok: false, reason: "bad-signature" };
}
