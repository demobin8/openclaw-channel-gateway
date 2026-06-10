/**
 * ESM loader hook for lite-gateway.
 *
 * Two interception layers:
 *
 * 1. **Source-level**: When code imports `openclaw/plugin-sdk/<module>` from
 *    source, redirect to our shim. This handles external plugins whose source
 *    hasn't been pre-compiled with openclaw's internal bundler.
 *
 * 2. **Chunk-level**: When compiled openclaw chunks (like
 *    `reply-dispatch-runtime-XXXXXXXX.js`) are loaded, the resolver notes
 *    their resolved URL. The `load` hook then replaces the source to forward
 *    dispatch calls to our HTTP agent instead of OpenClaw's engine.
 *
 * When our OWN shim files import from `openclaw/plugin-sdk/*`, the import
 * resolves normally — our shims re-export real utilities from openclaw
 * while replacing only the dispatch function.
 *
 * Usage: node --import ./dist/loader.js ...
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Source-level interception ────────────────────────────────────────────

const SHIM_MAP: Record<string, string> = {
  "reply-dispatch-runtime": "shims/reply-dispatch-runtime.js",
  "runtime-config-snapshot": "shims/runtime-config-snapshot.js",
  "session-store-runtime": "shims/session-store-runtime.js",
  "runtime-env": "shims/runtime-env.js",
};

const SHIM_PREFIX = "openclaw/plugin-sdk/";

function isOwnShimCaller(parentURL: string | undefined): boolean {
  if (!parentURL) return false;
  if (parentURL.includes("/lite-gateway/src/shims/")) return true;
  if (parentURL.includes("/lite-gateway/dist/shims/")) return true;
  return false;
}

// ── Chunk-level interception ─────────────────────────────────────────────

/**
 * Chunks whose source we entirely replace via the `load` hook.
 * Key = path sub-string to match in the resolved URL.
 * Value = relative path of our replacement source.
 */
const CHUNK_REPLACEMENTS: Record<string, string> = {
  "reply-dispatch-runtime-": "shims/reply-dispatch-runtime.js",
};

/**
 * Returns the replacement specifier if `url` matches a known chunk.
 */
function getChunkReplacement(url: string): string | null {
  const normalized = url.replace(/\\/g, "/");
  for (const [substr, replacement] of Object.entries(CHUNK_REPLACEMENTS)) {
    if (normalized.includes(`/openclaw/dist/`) && normalized.includes(substr)) {
      return replacement;
    }
  }
  return null;
}

// ── Hooks ────────────────────────────────────────────────────────────────

/**
 * `resolve` hook: intercept source-level bare-specifier imports.
 */
export async function resolve(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (specifier: string, context?: unknown) => Promise<{ url: string }>,
) {
  // Source-level interception
  if (specifier.startsWith(SHIM_PREFIX)) {
    const moduleName = specifier.slice(SHIM_PREFIX.length);
    const shimFile = SHIM_MAP[moduleName];

    if (shimFile && !isOwnShimCaller(context.parentURL)) {
      const base = pathToFileURL(__dirname).href;
      const shimUrl = `${base}${shimFile}`;
      try {
        return await nextResolve(shimUrl, context);
      } catch {
        const tsUrl = shimUrl.replace(/\.js$/, ".ts");
        return nextResolve(tsUrl, context);
      }
    }
  }

  return nextResolve(specifier, context);
}

/**
 * `load` hook: intercept compiled chunks and replace with our shim source.
 *
 * When a compiled openclaw chunk (e.g. `reply-dispatch-runtime-XXXXXXXX.js`)
 * is loaded, we return our shim's source instead. This lets plugins' internal
 * compiled imports receive our HTTP dispatch implementation.
 */
export async function load(
  url: string,
  context: { format?: string },
  nextLoad: (url: string, context?: unknown) => Promise<{ source: string; format: string }>,
) {
  const replacement = getChunkReplacement(url);

  if (replacement) {
    // For chunk replacement, we provide a minimal dispatch-only module.
    // The chunk only exports two functions (as `t` and `n`), so we inline
    // a simple re-export from our shim. Using a dynamic import avoids
    // circular resolution issues when our shim re-exports utilities.
    const replacementPath = path.resolve(__dirname, replacement);
    let shimUrl: string;
    if (existsSync(replacementPath)) {
      shimUrl = pathToFileURL(replacementPath).href;
    } else {
      shimUrl = pathToFileURL(replacementPath.replace(/\.js$/, ".ts")).href;
    }

    // Inline a module that imports our shim and re-exports with short names.
    // The compiled chunks use `import { t as ..., n as ... }` — they expect
    // export names `t` and `n`, not the full function names.
    const source = `
export { dispatchReplyWithBufferedBlockDispatcher as t } from ${JSON.stringify(shimUrl)};
export { dispatchReplyWithDispatcher as n } from ${JSON.stringify(shimUrl)};
`;

    return {
      format: context.format || "module",
      source,
    };
  }

  return nextLoad(url, context);
}
