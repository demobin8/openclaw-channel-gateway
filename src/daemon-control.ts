/**
 * Daemon process control for the CLI (OCG 1.3.0): stopping the detached
 * gateway cross-platform, log discovery / tailing, and the state-file pieces
 * that `ocg daemon *` needs.  See docs/techdesign-agent-cli.md §5.8.
 *
 * Windows note: a detached Node process does not receive SIGTERM, so the stop
 * path uses `taskkill /PID <pid> /T /F`; the mailbox JSONL is append-synced on
 * every state change, so a hard kill cannot lose queue state.
 */

import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfigPath } from "./config.js";
import { isProcessRunning } from "./process-state.js";

/**
 * Default start-log directory: `<configDir>/ocg.logs`, following
 * OCG_CONFIG_PATH like the state file and the local token.
 */
export function resolveDaemonLogDir(): string {
  return join(dirname(resolveConfigPath()), "ocg.logs");
}

/** Log files, newest first. */
export function listLogFiles(dir = resolveDaemonLogDir()): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => join(dir, name))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
  } catch {
    return [];
  }
}

export function latestLogFile(dir = resolveDaemonLogDir()): string | null {
  return listLogFiles(dir)[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop a background gateway process and wait for it to exit.
 *
 * POSIX: SIGTERM, escalating to SIGKILL after `timeoutMs`.
 * Windows: `taskkill /PID <pid> /T /F` (hard kill; accepted — see the module
 * header) and a wait for the PID to disappear.
 */
export async function stopDaemonProcess(
  pid: number,
  timeoutMs = 10_000,
): Promise<{ stopped: boolean; detail: string }> {
  if (!isProcessRunning(pid)) {
    return { stopped: true, detail: "process was not running" };
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return { stopped: true, detail: process.platform === "win32" ? "taskkill /T /F" : "SIGTERM" };
    }
    await sleep(200);
  }

  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore; the liveness check below decides.
    }
    const hardDeadline = Date.now() + 3000;
    while (Date.now() < hardDeadline) {
      if (!isProcessRunning(pid)) return { stopped: true, detail: "SIGKILL" };
      await sleep(200);
    }
  }

  return { stopped: false, detail: `process ${pid} is still running after ${timeoutMs}ms` };
}

/** Read the last `count` lines of a file (plain read; log files are modest). */
export function readLastLines(path: string, count: number): string[] {
  if (!existsSync(path)) return [];
  try {
    const text = statSync(path).size > 8 * 1024 * 1024
      ? readTailText(path, 8 * 1024 * 1024)
      : readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-Math.max(1, count));
  } catch {
    return [];
  }
}

function readTailText(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

/**
 * Follow a log file: print bytes appended after the current end, retrying
 * while the file is missing and handling truncation (rotation).
 * Stops when `shouldStop()` returns true.
 */
export async function followLogFile(
  path: string,
  write: (text: string) => void,
  shouldStop: () => boolean,
): Promise<void> {
  let offset = 0;
  try {
    offset = statSync(path).size;
  } catch {
    offset = 0;
  }

  while (!shouldStop()) {
    await sleep(500);
    try {
      const size = statSync(path).size;
      if (size < offset) offset = 0;
      if (size <= offset) continue;
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buffer, 0, length, offset);
      } finally {
        closeSync(fd);
      }
      offset = size;
      write(buffer.toString("utf8"));
    } catch {
      // File missing / replaced — retry on the next tick.
    }
  }
}
