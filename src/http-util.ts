/**
 * Small HTTP helpers shared by the callback server and the agent routes
 * (docs/techdesign-agent-cli.md §5.1).  Kept dependency-free and push-based:
 * bodies are read fully with an optional hard size cap.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Write a JSON response. */
export function jsonBody<T = unknown>(res: ServerResponse, code: number, body: T): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Read the full request body. */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
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
export async function readBodyLimited(req: IncomingMessage, limit: number): Promise<Buffer> {
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
