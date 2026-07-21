import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve as pathResolve, sep } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_REPLY_CHUNK_SIZE = 4000;
const MIN_REPLY_CHUNK_SIZE = 500;

export type DeliverFn = (
  payload: Record<string, unknown>,
  meta: Record<string, unknown>,
) => Promise<void>;

// ── QQ Bot media path rewriting ──────────────────────────────────────────

const MEDIA_TAG_REGEX = /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia)>/gi;

/** Return the QQ Bot media directory where local files must reside to pass the plugin's security check. */
export function resolveQqBotMediaDir(): string {
  const home = process.env.OPENCLAW_HOME?.trim() || homedir();
  const dir = join(home, ".openclaw", "media", "qqbot");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Return the OpenClaw shared media root (second allowlisted directory). */
export function resolveOpenClawMediaDir(): string {
  const home = process.env.OPENCLAW_HOME?.trim() || homedir();
  return join(home, ".openclaw", "media");
}

/**
 * Check whether a local path is inside one of the QQ Bot plugin's allowlisted
 * media directories.
 */
function isWithinAllowedMediaRoot(candidate: string): boolean {
  try {
    const resolved = pathResolve(candidate);
    const roots = [
      pathResolve(resolveQqBotMediaDir()),
      pathResolve(resolveOpenClawMediaDir()),
    ];
    for (const root of roots) {
      if (resolved === root) return true;
      if (resolved.startsWith(root + sep)) return true;
    }
  } catch {
    // Path resolution failed — treat as disallowed.
  }
  return false;
}

/**
 * Rewrite local media paths in QQ Bot inline tags so the resulting file
 * lives inside the plugin's allowlisted media directory.
 *
 * Scans `<qqimg>`, `<qqvoice>`, `<qqvideo>`, `<qqfile>`, and `<qqmedia>`
 * tags.  For each tag body that looks like a local absolute path *outside*
 * the allowed roots, the file is copied to `~/.openclaw/media/qqbot/` and
 * the tag is rewritten with the new path.  URLs (`http://`, `https://`,
 * `data:`) and already-allowed paths are left untouched.
 *
 * @param text  Raw reply text that may contain inline media tags.
 * @returns     Rewritten text suitable for delivery to QQ Bot.
 */
export function rewriteLocalMediaPathsForDelivery(text: string): string {
  if (!text) return text;

  // Quick check — skip the regex when there are no angle-bracket tags at all.
  if (!text.includes("<")) return text;

  const destDir = resolveQqBotMediaDir();

  return text.replace(MEDIA_TAG_REGEX, (match: string, tagName: string, rawPath: string) => {
    const trimmed = rawPath.trim();

    // Leave URL / data-URI sources untouched — the plugin handles them natively.
    if (/^(https?|data):/i.test(trimmed)) return match;

    // Resolve to absolute — relative paths anchored at CWD are unlikely to work,
    // but the plugin may normalise them; still, we only rewrite when we can
    // resolve cleanly.
    let resolved: string;
    try {
      resolved = pathResolve(trimmed);
    } catch {
      // Unresolvable — pass through as-is and let the plugin reject it.
      return match;
    }

    // Already inside an allowed root → no rewrite needed.
    if (isWithinAllowedMediaRoot(resolved)) return match;

    // File must exist for us to copy it.
    if (!existsSync(resolved)) return match;

    // Build a collision-safe name under the QQ Bot media dir.
    const ext = extname(basename(resolved));
    const stem = basename(resolved, ext).replace(/[<>:"/\\|?*]/g, "_").slice(0, 64);
    const ts = Date.now();
    const destName = `${stem}_${ts}${ext || ".png"}`;
    const destPath = join(destDir, destName);

    try {
      copyFileSync(resolved, destPath);
    } catch {
      // Copy failed — pass through the original tag so at least text is delivered.
      return match;
    }

    // Replace the path in the tag, preserving original tag name.
    return `<${tagName}>${destPath}</${tagName}>`;
  });
}

export function resolveReplyChunkSize(value?: unknown): number {
  const raw = value ?? process.env.OCG_REPLY_CHUNK_SIZE;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REPLY_CHUNK_SIZE;
  return Math.max(MIN_REPLY_CHUNK_SIZE, Math.floor(parsed));
}

export function splitReplyText(text: string, maxChars = resolveReplyChunkSize()): string[] {
  if (!text) return [""];

  const chars = Array.from(text);
  if (chars.length <= maxChars) return [text];

  const chunks: string[] = [];
  let offset = 0;

  while (offset < chars.length) {
    const remaining = chars.length - offset;
    if (remaining <= maxChars) {
      chunks.push(chars.slice(offset).join(""));
      break;
    }

    const hardEnd = offset + maxChars;
    const next = chooseSplitIndex(chars, offset, hardEnd);
    const chunk = chars.slice(offset, next).join("").trimEnd();
    if (chunk) chunks.push(chunk);

    offset = next;
    while (offset < chars.length && /\s/.test(chars[offset])) offset += 1;
  }

  return chunks.length > 0 ? chunks : [text];
}

function chooseSplitIndex(chars: string[], start: number, hardEnd: number): number {
  const minSplit = start + Math.floor((hardEnd - start) * 0.6);
  const preferredBreaks = ["\n\n", "\n", "。", "！", "？", ".", "!", "?", "；", ";", "，", ",", " "];

  for (const marker of preferredBreaks) {
    const found = findLastMarker(chars, marker, minSplit, hardEnd);
    if (found > start) return found;
  }

  return hardEnd;
}

function findLastMarker(chars: string[], marker: string, min: number, end: number): number {
  if (marker.length === 1) {
    for (let i = end - 1; i >= min; i -= 1) {
      if (chars[i] === marker) return i + 1;
    }
    return -1;
  }

  const markerChars = Array.from(marker);
  for (let i = end - markerChars.length; i >= min; i -= 1) {
    let matched = true;
    for (let j = 0; j < markerChars.length; j += 1) {
      if (chars[i + j] !== markerChars[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i + markerChars.length;
  }
  return -1;
}

export async function deliverPayloadInChunks(
  deliver: DeliverFn,
  payload: Record<string, unknown>,
  meta: Record<string, unknown>,
  maxChars = resolveReplyChunkSize(),
): Promise<number> {
  const text = payload.text;
  if (typeof text !== "string") {
    await deliver(payload, meta);
    return 1;
  }

  let chunks = splitReplyText(text, maxChars);
  if (chunks.length <= 1) {
    await deliver(payload, meta);
    return 1;
  }

  let total = chunks.length;
  while (true) {
    const prefixChars = `[${total}/${total}]\n`.length;
    const bodyMaxChars = Math.max(MIN_REPLY_CHUNK_SIZE, maxChars - prefixChars);
    const nextChunks = splitReplyText(text, bodyMaxChars);
    if (nextChunks.length === total) {
      chunks = nextChunks;
      break;
    }
    chunks = nextChunks;
    total = chunks.length;
  }

  for (let index = 0; index < total; index += 1) {
    const partText = `[${index + 1}/${total}]\n${chunks[index]}`;
    await deliver(
      {
        ...payload,
        text: partText,
      },
      {
        ...meta,
        chunkIndex: index,
        chunkCount: total,
      },
    );
  }

  return total;
}
