export const DEFAULT_REPLY_CHUNK_SIZE = 4000;
const MIN_REPLY_CHUNK_SIZE = 500;

export type DeliverFn = (
  payload: Record<string, unknown>,
  meta: Record<string, unknown>,
) => Promise<void>;

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
