/**
 * DingTalk Device Authorization Flow (QR code login)
 *
 * Replicates the logic from @dingtalk-real-ai/dingtalk-connector/bin/dingtalk-connector.js
 * but adapted for lite-gateway's config system (ocg.json instead of openclaw.json).
 *
 * Flow:
 *   1. POST /app/registration/init   → nonce
 *   2. POST /app/registration/begin  → device_code, verification_uri_complete
 *   3. Show QR code (verification_uri_complete) to user
 *   4. Poll POST /app/registration/poll until SUCCESS → clientId, clientSecret
 */

const BASE_URL =
  (process.env["DINGTALK_REGISTRATION_BASE_URL"] || "").trim() ||
  "https://oapi.dingtalk.com";
const SOURCE =
  (process.env["DINGTALK_REGISTRATION_SOURCE"] || "").trim() ||
  "DING_DWS_CLAW";

const RETRY_WINDOW_MS = 2 * 60 * 1000;

export interface DeviceAuthSession {
  nonce: string;
  deviceCode: string;
  verifyUrl: string;
  intervalMs: number;
  expiresInSec: number;
  startedAt: number;
}

async function apiPost(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!data || (data.errcode as number) !== 0) {
    throw new Error(
      `[DingTalk API] ${data?.errmsg || "unknown error"} (errcode=${data?.errcode ?? "N/A"})`,
    );
  }
  return data;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start the DingTalk device auth flow.
 * Returns the QR verification URL and a session key for polling.
 */
export async function dingtalkLoginStart(): Promise<{
  qrDataUrl: string;
  session: DeviceAuthSession;
}> {
  // Step 1: Init
  const initData = await apiPost(`${BASE_URL}/app/registration/init`, {
    source: SOURCE,
  });
  const nonce = String(initData["nonce"] ?? "").trim();
  if (!nonce) throw new Error("device auth init: missing nonce");

  // Step 2: Begin
  const beginData = await apiPost(`${BASE_URL}/app/registration/begin`, {
    nonce,
  });
  const deviceCode = String(beginData["device_code"] ?? "").trim();
  const verifyUrl = String(
    beginData["verification_uri_complete"] ?? "",
  ).trim();
  const interval = Math.max(3, Number(beginData["interval"] ?? 3));
  const expiresIn = Math.max(60, Number(beginData["expires_in"] ?? 7200));

  if (!deviceCode || !verifyUrl) {
    throw new Error("device auth begin: missing device_code or verification_uri");
  }

  const session: DeviceAuthSession = {
    nonce,
    deviceCode,
    verifyUrl,
    intervalMs: interval * 1000,
    expiresInSec: expiresIn,
    startedAt: Date.now(),
  };

  return { qrDataUrl: verifyUrl, session };
}

/**
 * Poll the DingTalk device auth flow until completion or timeout.
 * Returns credentials on success.
 *
 * @param session - The active device auth session
 * @param signal - Optional AbortSignal for cancellation
 * @param timeoutMs - Optional max wait time in milliseconds (default: 120s)
 */
export async function dingtalkLoginWait(
  session: DeviceAuthSession,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ clientId: string; clientSecret: string }> {
  const deadline = Math.min(
    session.startedAt + session.expiresInSec * 1000,
    session.startedAt + timeoutMs,
  );

  let retryStart = 0;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("Login cancelled");
    }

    await sleep(session.intervalMs);

    let poll: Record<string, unknown>;
    try {
      poll = await apiPost(`${BASE_URL}/app/registration/poll`, {
        device_code: session.deviceCode,
      });
    } catch (err) {
      // Network/server error — retry within window
      if (!retryStart) retryStart = Date.now();
      lastError = (err as Error).message;
      if (Date.now() - retryStart < RETRY_WINDOW_MS) {
        continue;
      }
      throw new Error(
        `Poll failed after ${RETRY_WINDOW_MS / 1000}s retries: ${lastError}`,
      );
    }

    const status = String(poll["status"] ?? "").trim().toUpperCase();
    if (status === "WAITING") {
      retryStart = 0;
      continue;
    }

    if (status === "SUCCESS") {
      const clientId = String(poll["client_id"] ?? "").trim();
      const clientSecret = String(poll["client_secret"] ?? "").trim();
      if (!clientId || !clientSecret) {
        throw new Error("Device auth succeeded but credentials missing");
      }
      return { clientId, clientSecret };
    }

    // FAIL / EXPIRED / unknown
    if (!retryStart) retryStart = Date.now();
    lastError =
      status === "FAIL"
        ? String(poll["fail_reason"] ?? "authorization failed")
        : `status: ${status}`;
    if (Date.now() - retryStart < RETRY_WINDOW_MS) {
      continue;
    }
    throw new Error(lastError);
  }

  throw new Error("Device authorization timed out");
}
