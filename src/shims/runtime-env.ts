/**
 * Lite gateway shim for `openclaw/plugin-sdk/runtime-env`.
 *
 * Provides minimal runtime environment utilities (logging, sleep, etc.)
 * backed by console and Node.js stdlib.
 */

// ── Logging ──────────────────────────────────────────────────────────────

let _verbose = process.env.LITE_GATEWAY_VERBOSE === "1";

export function setVerbose(v: boolean) {
  _verbose = v;
}

export function isVerbose(): boolean {
  return _verbose;
}

export function shouldLogVerbose(): boolean {
  return _verbose;
}

export function logVerbose(...args: unknown[]) {
  if (_verbose) console.log("[lite-gateway:verbose]", ...args);
}

export function logVerboseConsole(...args: unknown[]) {
  console.log("[lite-gateway]", ...args);
}

export function info(...args: unknown[]) {
  console.log("[lite-gateway:info]", ...args);
}

export function success(...args: unknown[]) {
  console.log("[lite-gateway]", ...args);
}

export function warn(...args: unknown[]) {
  console.warn("[lite-gateway:warn]", ...args);
}

export function danger(...args: unknown[]) {
  console.error("[lite-gateway:error]", ...args);
}

// ── Yes mode ─────────────────────────────────────────────────────────────

let _yes = false;

export function setYes(v: boolean) {
  _yes = v;
}

export function isYes(): boolean {
  return _yes;
}

// ── Runtime env ──────────────────────────────────────────────────────────

export function defaultRuntime(): Record<string, unknown> {
  return {
    logger: {
      info: (...args: unknown[]) => console.log("[openclaw]", ...args),
      warn: (...args: unknown[]) => console.warn("[openclaw:warn]", ...args),
      error: (...args: unknown[]) => console.error("[openclaw:error]", ...args),
      verbose: (...args: unknown[]) => (_verbose ? console.log("[openclaw:verbose]", ...args) : undefined),
    },
  };
}

export function createNonExitingRuntime(opts: Record<string, unknown> = {}) {
  return defaultRuntime();
}

export type RuntimeEnv = ReturnType<typeof defaultRuntime>;

// ── Utilities ────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message ?? `Timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function isTruthyEnvValue(value: string | undefined): boolean {
  return !!value && value !== "0" && value !== "false";
}

// ── Backoff ──────────────────────────────────────────────────────────────

export type BackoffPolicy = {
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
};

export function computeBackoff(attempt: number, policy: BackoffPolicy): number {
  return Math.min(policy.initialDelayMs * Math.pow(policy.factor, attempt), policy.maxDelayMs);
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// ── Format ───────────────────────────────────────────────────────────────

export function formatDurationPrecise(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDurationSeconds(s: number): string {
  return formatDurationPrecise(s * 1000);
}

// ── Retry ────────────────────────────────────────────────────────────────

export async function retryAsync<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; delayMs?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxRetries) {
        opts.onRetry?.(err, i);
        await sleep(delayMs * Math.pow(2, i));
      }
    }
  }
  throw lastErr;
}

// ── Uncaught handlers ────────────────────────────────────────────────────

export function registerUncaughtExceptionHandler() {
  process.on("uncaughtException", (err) => {
    console.error("[lite-gateway] Uncaught exception:", err);
  });
}

export function registerUnhandledRejectionHandler() {
  process.on("unhandledRejection", (reason) => {
    console.error("[lite-gateway] Unhandled rejection:", reason);
  });
}

// ── WSL ─────────────────────────────────────────────────────────────────

export function isWSL2Sync(): boolean {
  return false;
}

// ── Net ──────────────────────────────────────────────────────────────────

export function ensureGlobalUndiciEnvProxyDispatcher(): void {
  // No-op for lite gateway
}

// ── Logging re-exports ───────────────────────────────────────────────────

export function createLogger(name: string) {
  return {
    info: (...args: unknown[]) => console.log(`[${name}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${name}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${name}]`, ...args),
    verbose: (...args: unknown[]) => (_verbose ? console.log(`[${name}:verbose]`, ...args) : undefined),
    debug: (...args: unknown[]) => (_verbose ? console.log(`[${name}:debug]`, ...args) : undefined),
  };
}
