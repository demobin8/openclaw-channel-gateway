/**
 * Mailbox transport for agentType: "mailbox" (OCG 1.3.0).
 *
 * Inbound messages are queued in the daemon, leased by consumers
 * (`ocg inbox wait`) and finished by `ocg reply` / `ocg inbox ack`.  State is
 * kept in memory and mirrored to an append-only JSONL log
 * (`<configDir>/mailbox/mailbox.jsonl`) so a daemon restart re-queues work;
 * reply handles cannot survive a restart (the plugin dispatcher lives in the
 * old process), so replayed messages are `replyable: false` and replies
 * degrade to a proactive send.
 *
 * See docs/techdesign-agent-cli.md §5.3–§5.5, §5.12.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  loadConfig,
  resolveConfigPath,
  resolveMailboxSettings,
  type MailboxSettings,
} from "./config.js";
import type { DeliverFn } from "./reply-chunking.js";

// ── Message model (§5.3) ──────────────────────────────────────────────────

export type InboundMedia = {
  path: string | null;
  url: string | null;
  mime: string | null;
};

export type InboundMessage = {
  /** "m_" + time-ordered random suffix, globally unique. */
  id: string;
  channel: string;
  accountId: string;
  /** Normalized peer target (same vocabulary as X-OCG-Target); null when unknown. */
  target: string | null;
  sessionKey: string;
  chatType: "direct" | "group" | "channel" | "unknown";
  sender: { id: string | null; name: string | null };
  groupSubject: string | null;
  text: string;
  media: InboundMedia[];
  platformMessageId: string | null;
  replyToId: string | null;
  wasMentioned: boolean | null;
  receivedAt: number;
};

export type MailboxState = "pending" | "leased" | "done";
export type MailboxDoneBy = "reply" | "ack" | "expired";

/** Public entry shape returned by the HTTP routes / CLI (no internal fields). */
export type MailboxEntry = InboundMessage & {
  state: MailboxState;
  consumer: string | null;
  leaseExpiresAt: number | null;
  redeliveries: number;
  /** Reply handle still valid (false after TTL expiry or a daemon restart). */
  replyable: boolean;
  replyExpiresAt: number | null;
  doneBy: MailboxDoneBy | null;
  doneAt: number | null;
};

/** Internally stored entry: everything except the derived reply-handle fields. */
type StoredEntry = Omit<MailboxEntry, "replyable" | "replyExpiresAt">;

export type MailboxTarget = {
  channel: string;
  accountId: string;
  target: string;
  chatType: string;
  senderId: string | null;
  senderName: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
};

/** A deliver function kept alive for a message, mirroring registerDeliver TTL semantics. */
export type ReplyHandle = { deliver: DeliverFn; expiresAt: number };

// ── Log records ───────────────────────────────────────────────────────────

type MailboxLogRecord =
  | { type: "enqueue"; t: number; entry: StoredEntry }
  | {
      type: "state";
      t: number;
      id: string;
      state: MailboxState;
      consumer: string | null;
      leaseExpiresAt: number | null;
      redeliveries: number;
      doneBy: MailboxDoneBy | null;
      doneAt: number | null;
    }
  | { type: "media"; t: number; id: string; media: InboundMedia[] }
  | { type: "drop"; t: number; id: string; reason: string }
  | { type: "snapshot"; t: number; entries: StoredEntry[] };

// ── Options / results ─────────────────────────────────────────────────────

export type MailboxOptions = {
  /** Root directory (default `<configDir>/mailbox`). */
  dir?: string;
  settings?: MailboxSettings;
  now?: () => number;
  log?: (line: string) => void;
  /** Start the background sweep timer (default true; tests can disable). */
  startTimers?: boolean;
  /** Sweep interval in ms (default 5000). */
  tickMs?: number;
};

export type MailboxWaitRequest = {
  consumer: string;
  channel?: string | null;
  timeoutMs?: number;
  max?: number;
  peek?: boolean;
  signal?: AbortSignal;
};

export type MailboxWaitResult = {
  messages: MailboxEntry[];
  leaseExpiresAt: number | null;
};

export type MailboxAckResult =
  | { ok: true; entry: MailboxEntry; alreadyDone?: boolean }
  | { ok: false; code: "NOT_FOUND" | "LEASE_HELD_BY_OTHER"; message: string };

const DAY_MS = 24 * 60 * 60_000;
const MAX_WAIT_MS = 120_000;
const DEFAULT_WAIT_MS = 60_000;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

/** Time-ordered message id: "m_" + base36 timestamp + 8 random hex chars. */
export function newMessageId(now = Date.now()): string {
  const time = now.toString(36).padStart(9, "0");
  return `m_${time}${randomBytes(4).toString("hex")}`;
}

/** Resolve `<configDir>/mailbox` (follows OCG_CONFIG_PATH like the rest of OCG). */
export function resolveMailboxDir(): string {
  return join(dirname(resolveConfigPath()), "mailbox");
}

// ── Mailbox ───────────────────────────────────────────────────────────────

type Waiter = {
  consumer: string;
  channel: string | null;
  max: number;
  peek: boolean;
  resolve: (result: MailboxWaitResult) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
};

export class Mailbox {
  readonly dir: string;
  readonly logPath: string;
  readonly mediaDir: string;
  readonly settings: MailboxSettings;

  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private entries = new Map<string, StoredEntry>();
  private handles = new Map<string, ReplyHandle>();
  private waiters: Waiter[] = [];
  private targetIndex = new Map<string, MailboxTarget>();
  private timer: NodeJS.Timeout | null = null;
  private lastRetentionAt = 0;

  constructor(options: MailboxOptions = {}) {
    this.dir = options.dir ?? resolveMailboxDir();
    this.logPath = join(this.dir, "mailbox.jsonl");
    this.mediaDir = join(this.dir, "media");
    this.settings = options.settings ?? resolveMailboxSettings(loadConfig());
    this.now = options.now ?? Date.now;
    this.log =
      options.log ??
      ((line: string) => console.log(`[ocg:mailbox] ${line}`));

    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      // The queue still works in memory if the directory cannot be created.
    }

    this.replay();
    // Startup compaction also applies the retention policy (see §5.12).
    try {
      this.runRetention(this.now());
    } catch (err) {
      this.log(`retention failed: ${(err as Error).message}`);
    }

    if (options.startTimers !== false) {
      const interval = options.tickMs && options.tickMs > 0 ? options.tickMs : 5000;
      this.timer = setInterval(() => {
        try {
          this.sweep();
        } catch (err) {
          this.log(`sweep failed: ${(err as Error).message}`);
        }
      }, interval);
    }
  }

  // ── Queue operations ─────────────────────────────────────────────────────

  /**
   * Enqueue one inbound message. `handle` is the plugin's passive-reply
   * deliver function; omit it (or let it expire) to force the `send` fallback.
   */
  enqueue(message: InboundMessage, handle?: ReplyHandle | null): MailboxEntry {
    // Cap: drop the oldest pending message when the queue is full.
    while (this.countState("pending") >= this.settings.maxPending) {
      const oldest = this.oldestPending();
      if (!oldest) break;
      this.entries.delete(oldest.id);
      this.appendLog({ type: "drop", t: this.now(), id: oldest.id, reason: "queue-full" });
      this.log(`queue full (${this.settings.maxPending}); dropped oldest pending id=${oldest.id}`);
    }

    const entry: StoredEntry = {
      ...message,
      state: "pending",
      consumer: null,
      leaseExpiresAt: null,
      redeliveries: 0,
      doneBy: null,
      doneAt: null,
    };
    this.entries.set(entry.id, entry);
    if (handle) this.handles.set(entry.id, handle);
    this.recordTarget(entry);
    this.appendLog({ type: "enqueue", t: this.now(), entry });

    if (this.settings.downloadMedia) {
      void this.downloadMediaFor(entry).catch((err: unknown) => {
        this.log(`media download error id=${entry.id}: ${(err as Error).message}`);
      });
    }

    this.wakeWaiters();
    return this.toPublic(entry);
  }

  /**
   * Long-poll for pending messages.  Returns immediately when work exists;
   * otherwise waits up to `timeoutMs` (max 120 s) and resolves with an empty
   * list on timeout — "no messages" is not an error (§5.4).
   */
  wait(request: MailboxWaitRequest): Promise<MailboxWaitResult> {
    const consumer = request.consumer?.trim() || "default";
    const timeoutMs = clampInt(request.timeoutMs, 0, MAX_WAIT_MS, DEFAULT_WAIT_MS);
    const max = clampInt(request.max, 1, 10, 1);
    const channel = request.channel?.trim() || null;
    const peek = request.peek === true;

    const empty: MailboxWaitResult = { messages: [], leaseExpiresAt: null };
    if (request.signal?.aborted) return Promise.resolve(empty);

    const immediate = this.takePending(consumer, channel, max, peek);
    if (immediate.messages.length > 0 || timeoutMs === 0) {
      return Promise.resolve(immediate);
    }

    return new Promise<MailboxWaitResult>((resolve) => {
      const waiter: Waiter = {
        consumer,
        channel,
        max,
        peek,
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          resolve(empty);
        }, timeoutMs),
        signal: request.signal,
      };
      if (request.signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waiter);
          resolve(empty);
        };
        request.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** List entries with optional state / channel / since filters. */
  list(options: {
    states?: MailboxState[];
    channel?: string | null;
    limit?: number;
    since?: number | null;
  } = {}): MailboxEntry[] {
    const states = options.states && options.states.length > 0 ? new Set(options.states) : null;
    const limit = clampInt(options.limit, 1, 500, 50);
    const since = typeof options.since === "number" && Number.isFinite(options.since) ? options.since : null;
    const out: MailboxEntry[] = [];
    for (const entry of this.entries.values()) {
      if (states && !states.has(entry.state)) continue;
      if (options.channel && entry.channel !== options.channel) continue;
      if (since !== null && entry.receivedAt < since) continue;
      out.push(this.toPublic(entry));
    }
    // Newest first — `limit` applies to the most recent entries.
    out.sort((a, b) => b.receivedAt - a.receivedAt);
    return out.slice(0, limit);
  }

  get(id: string): MailboxEntry | null {
    const entry = this.entries.get(id);
    return entry ? this.toPublic(entry) : null;
  }

  /** End a lease without replying (doneBy=ack). */
  ack(id: string, options: { consumer?: string | null; force?: boolean } = {}): MailboxAckResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, code: "NOT_FOUND", message: `unknown message id "${id}"` };
    if (entry.state === "done") {
      return { ok: true, entry: this.toPublic(entry), alreadyDone: true };
    }
    const consumer = options.consumer?.trim() || null;
    if (
      options.force !== true &&
      entry.state === "leased" &&
      entry.consumer &&
      consumer &&
      entry.consumer !== consumer
    ) {
      return {
        ok: false,
        code: "LEASE_HELD_BY_OTHER",
        message: `message "${id}" is leased by consumer "${entry.consumer}"`,
      };
    }
    this.markDone(entry, "ack");
    return { ok: true, entry: this.toPublic(entry) };
  }

  /** Finish a message after a successful reply. */
  markReplied(id: string): MailboxEntry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.markDone(entry, "reply");
    return this.toPublic(entry);
  }

  /**
   * Take (consume) the reply handle — single-use, like `/ocg/callback`.
   * Returns null when absent, expired, or gone after a daemon restart.
   */
  consumeReplyHandle(id: string): ReplyHandle | null {
    const handle = this.handles.get(id);
    if (!handle) return null;
    this.handles.delete(id);
    if (handle.expiresAt <= this.now()) return null;
    return handle;
  }

  /** Whether a reply handle currently exists and is valid. */
  hasReplyHandle(id: string): boolean {
    const handle = this.handles.get(id);
    return Boolean(handle && handle.expiresAt > this.now());
  }

  /** Recent peers seen on mailbox-enqueued messages (survives restarts via the log). */
  targets(options: { channel?: string | null; limit?: number } = {}): MailboxTarget[] {
    const limit = clampInt(options.limit, 1, 200, 50);
    const out: MailboxTarget[] = [];
    for (const target of this.targetIndex.values()) {
      if (options.channel && target.channel !== options.channel) continue;
      out.push({ ...target });
    }
    out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return out.slice(0, limit);
  }

  stats(): { pending: number; leased: number; done: number; oldestPendingAt: number | null } {
    let oldestPendingAt: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.state !== "pending") continue;
      if (oldestPendingAt === null || entry.receivedAt < oldestPendingAt) {
        oldestPendingAt = entry.receivedAt;
      }
    }
    return {
      pending: this.countState("pending"),
      leased: this.countState("leased"),
      done: this.countState("done"),
      oldestPendingAt,
    };
  }

  /** Stop the sweep timer and release waiters (tests / shutdown). */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.resolve({ messages: [], leaseExpiresAt: null });
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Lease-expiry sweep + handle purge + periodic retention. Exposed for tests. */
  sweep(): void {
    const now = this.now();

    let requeued = false;
    for (const entry of this.entries.values()) {
      if (entry.state !== "leased") continue;
      if (entry.leaseExpiresAt === null || entry.leaseExpiresAt > now) continue;
      const next = entry.redeliveries + 1;
      if (this.settings.maxRedeliveries >= 0 && next > this.settings.maxRedeliveries) {
        this.log(
          `lease expired ${next} time(s) for id=${entry.id}; marking expired (mailboxMaxRedeliveries=${this.settings.maxRedeliveries})`,
        );
        this.markDone(entry, "expired");
        continue;
      }
      entry.redeliveries = next;
      entry.state = "pending";
      entry.consumer = null;
      entry.leaseExpiresAt = null;
      this.appendLogState(entry);
      this.log(`lease expired; id=${entry.id} back to pending (redeliveries=${next})`);
      requeued = true;
    }

    for (const [id, handle] of [...this.handles]) {
      if (handle.expiresAt <= now) this.handles.delete(id);
    }

    if (now - this.lastRetentionAt >= 6 * 60 * 60_000) {
      this.runRetention(now);
    }

    if (requeued) this.wakeWaiters();
  }

  private countState(state: MailboxState): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === state) count += 1;
    }
    return count;
  }

  private oldestPending(): StoredEntry | null {
    let oldest: StoredEntry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.state !== "pending") continue;
      if (!oldest || entry.receivedAt < oldest.receivedAt) oldest = entry;
    }
    return oldest;
  }

  private toPublic(entry: StoredEntry): MailboxEntry {
    const handle = this.handles.get(entry.id);
    const alive = Boolean(handle && handle.expiresAt > this.now() && entry.state !== "done");
    return {
      ...entry,
      replyable: alive,
      replyExpiresAt: handle ? handle.expiresAt : null,
    };
  }

  private pickPending(channel: string | null, max: number): StoredEntry[] {
    const out: StoredEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state !== "pending") continue;
      if (channel && entry.channel !== channel) continue;
      out.push(entry);
      if (out.length >= max) break;
    }
    return out;
  }

  private takePending(
    consumer: string,
    channel: string | null,
    max: number,
    peek: boolean,
  ): MailboxWaitResult {
    const picked = this.pickPending(channel, max);
    if (picked.length === 0) return { messages: [], leaseExpiresAt: null };
    if (peek) {
      return { messages: picked.map((entry) => this.toPublic(entry)), leaseExpiresAt: null };
    }
    const leaseExpiresAt = this.now() + this.settings.leaseMs;
    for (const entry of picked) {
      entry.state = "leased";
      entry.consumer = consumer;
      entry.leaseExpiresAt = leaseExpiresAt;
      this.appendLogState(entry);
    }
    this.log(`leased ${picked.length} message(s) to consumer="${consumer}" until ${leaseExpiresAt}`);
    return { messages: picked.map((entry) => this.toPublic(entry)), leaseExpiresAt };
  }

  private wakeWaiters(): void {
    if (this.waiters.length === 0) return;
    for (const waiter of [...this.waiters]) {
      const result = this.takePending(waiter.consumer, waiter.channel, waiter.max, waiter.peek);
      if (result.messages.length === 0) continue;
      this.removeWaiter(waiter);
      waiter.resolve(result);
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private markDone(entry: StoredEntry, doneBy: MailboxDoneBy): void {
    entry.state = "done";
    entry.consumer = null;
    entry.leaseExpiresAt = null;
    entry.doneBy = doneBy;
    entry.doneAt = this.now();
    this.handles.delete(entry.id);
    this.appendLogState(entry);
    this.log(`done id=${entry.id} by=${doneBy}`);
  }

  private appendLogState(entry: StoredEntry): void {
    this.appendLog({
      type: "state",
      t: this.now(),
      id: entry.id,
      state: entry.state,
      consumer: entry.consumer,
      leaseExpiresAt: entry.leaseExpiresAt,
      redeliveries: entry.redeliveries,
      doneBy: entry.doneBy,
      doneAt: entry.doneAt,
    });
  }

  private appendLog(record: MailboxLogRecord): void {
    try {
      appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      this.log(`failed to append log: ${(err as Error).message}`);
    }
  }

  private recordTarget(entry: StoredEntry): void {
    if (!entry.target) return;
    const key = `${entry.channel}\u0000${entry.target}`;
    const existing = this.targetIndex.get(key);
    if (existing) {
      existing.lastSeenAt = entry.receivedAt;
      existing.count += 1;
      existing.chatType = entry.chatType;
      existing.senderId = entry.sender.id ?? existing.senderId;
      existing.senderName = entry.sender.name ?? existing.senderName;
      return;
    }
    this.targetIndex.set(key, {
      channel: entry.channel,
      accountId: entry.accountId,
      target: entry.target,
      chatType: entry.chatType,
      senderId: entry.sender.id,
      senderName: entry.sender.name,
      firstSeenAt: entry.receivedAt,
      lastSeenAt: entry.receivedAt,
      count: 1,
    });
  }

  // ── Replay / retention ───────────────────────────────────────────────────

  private replay(): void {
    if (!existsSync(this.logPath)) return;
    let text: string;
    try {
      text = readFileSync(this.logPath, "utf8");
    } catch {
      return;
    }

    const entries = new Map<string, StoredEntry>();
    const targets = new Map<string, MailboxTarget>();
    const recordTarget = (entry: StoredEntry): void => {
      if (!entry.target) return;
      const key = `${entry.channel}\u0000${entry.target}`;
      const existing = targets.get(key);
      if (existing) {
        existing.lastSeenAt = Math.max(existing.lastSeenAt, entry.receivedAt);
        existing.count += 1;
        return;
      }
      targets.set(key, {
        channel: entry.channel,
        accountId: entry.accountId,
        target: entry.target,
        chatType: entry.chatType,
        senderId: entry.sender.id,
        senderName: entry.sender.name,
        firstSeenAt: entry.receivedAt,
        lastSeenAt: entry.receivedAt,
        count: 1,
      });
    };

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let record: MailboxLogRecord;
      try {
        record = JSON.parse(line) as MailboxLogRecord;
      } catch {
        continue;
      }
      switch (record.type) {
        case "snapshot":
          entries.clear();
          for (const entry of record.entries) {
            entries.set(entry.id, entry);
            recordTarget(entry);
          }
          break;
        case "enqueue":
          entries.set(record.entry.id, record.entry);
          recordTarget(record.entry);
          break;
        case "state": {
          const entry = entries.get(record.id);
          if (!entry) break;
          entry.state = record.state;
          entry.consumer = record.consumer;
          entry.leaseExpiresAt = record.leaseExpiresAt;
          entry.redeliveries = record.redeliveries;
          entry.doneBy = record.doneBy;
          entry.doneAt = record.doneAt;
          break;
        }
        case "media": {
          const entry = entries.get(record.id);
          if (entry) entry.media = record.media;
          break;
        }
        case "drop":
          entries.delete(record.id);
          break;
        default:
          break;
      }
    }

    // Leases cannot survive a restart: re-queue leased messages, counting a
    // redelivery, and honour the expiry cap.
    for (const entry of entries.values()) {
      if (entry.state !== "leased") continue;
      const next = entry.redeliveries + 1;
      if (this.settings.maxRedeliveries >= 0 && next > this.settings.maxRedeliveries) {
        entry.state = "done";
        entry.doneBy = "expired";
        entry.doneAt = this.now();
      } else {
        entry.state = "pending";
        entry.redeliveries = next;
      }
      entry.consumer = null;
      entry.leaseExpiresAt = null;
    }

    this.entries = entries;
    this.targetIndex = targets;
    this.log(`replayed ${entries.size} entr(ies) from ${this.logPath}`);
  }

  private runRetention(now: number): void {
    this.lastRetentionAt = now;

    // Drop done entries older than the history window (both memory and log).
    const historyCutoff = now - this.settings.historyRetentionDays * DAY_MS;
    for (const [id, entry] of [...this.entries]) {
      if (entry.state === "done" && (entry.doneAt ?? entry.receivedAt) < historyCutoff) {
        this.entries.delete(id);
      }
    }
    this.compact(now);

    // Media cleanup by directory age.
    const mediaCutoff = now - this.settings.mediaRetentionDays * DAY_MS;
    if (existsSync(this.mediaDir)) {
      for (const name of readdirSync(this.mediaDir)) {
        const path = join(this.mediaDir, name);
        try {
          if (statSync(path).mtimeMs < mediaCutoff) {
            rmSync(path, { recursive: true, force: true });
          }
        } catch {
          // Ignore individual cleanup failures.
        }
      }
    }
  }

  /** Rewrite the log as a single snapshot of the current entries. */
  private compact(now: number): void {
    const record: MailboxLogRecord = { type: "snapshot", t: now, entries: [...this.entries.values()] };
    const tmp = `${this.logPath}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(record)}\n`, "utf8");
      renameSync(tmp, this.logPath);
    } catch (err) {
      this.log(`compaction failed: ${(err as Error).message}`);
    }
  }

  // ── Media download (§5.12) ───────────────────────────────────────────────

  private async downloadMediaFor(entry: StoredEntry): Promise<void> {
    for (let index = 0; index < entry.media.length; index += 1) {
      const item = entry.media[index];
      if (item.path || !item.url) continue;
      if (!/^https?:/i.test(item.url)) continue;

      try {
        const response = await fetch(item.url, {
          signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
          redirect: "follow",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) throw new Error("empty body");
        if (buffer.length > MAX_MEDIA_BYTES) {
          throw new Error(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
        }

        const dir = join(this.mediaDir, entry.id);
        mkdirSync(dir, { recursive: true });
        const file = join(
          dir,
          `${index}${extensionFor(item.url, response.headers.get("content-type"), item.mime)}`,
        );
        writeFileSync(file, buffer);
        item.path = file;
        this.appendLog({ type: "media", t: this.now(), id: entry.id, media: entry.media });
        this.log(`media downloaded id=${entry.id} index=${index} → ${file}`);
      } catch (err) {
        this.log(`media download failed id=${entry.id} index=${index}: ${(err as Error).message}`);
      }
    }
  }
}

function extensionFor(url: string, contentType: string | null, mime: string | null): string {
  try {
    const ext = extname(new URL(url).pathname);
    if (/^\.[a-z0-9]{1,6}$/i.test(ext)) return ext.toLowerCase();
  } catch {
    // Not a parseable URL — fall through to MIME sniffing.
  }
  const type = (contentType ?? mime ?? "").split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  };
  return map[type] ?? ".bin";
}

// ── Process-wide singleton (daemon) ───────────────────────────────────────

let _mailbox: Mailbox | null = null;

/** The active mailbox, or null when `ensureMailbox` has not run yet. */
export function getMailbox(): Mailbox | null {
  return _mailbox;
}

/** Get (or lazily create) the process-wide mailbox. */
export function ensureMailbox(options?: MailboxOptions): Mailbox {
  if (!_mailbox) _mailbox = new Mailbox(options);
  return _mailbox;
}

/** Tear down the singleton (tests / graceful shutdown). */
export function resetMailbox(): void {
  if (_mailbox) {
    _mailbox.dispose();
    _mailbox = null;
  }
}
