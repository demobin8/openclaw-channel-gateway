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
