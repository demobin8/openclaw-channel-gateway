import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveConfigDir } from "./config.js";

export type AcpAgentConfig = {
  /** Path/name of the ACP-capable binary, e.g. claude-agent-acp, codex-acp, codex. */
  command?: string;
  /** Extra command args, e.g. ["app-server", "--listen", "stdio://"] for Codex app-server. */
  args?: string[];
  /** Optional model passed to protocols that support a model field. */
  model?: string;
  /** Working directory used when creating ACP sessions/turns. */
  cwd?: string;
  /** Extra environment variables for the subprocess. */
  env?: Record<string, string>;
  /** Optional system prompt retained for forward compatibility. */
  systemPrompt?: string;
  /** Request timeout in milliseconds. Defaults to 1800000 (30 minutes). */
  timeoutMs?: number;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
  params?: unknown;
};

type SessionUpdate = {
  sessionUpdate?: string;
  content?: unknown;
  type?: string;
  text?: string;
};

type CodexTurnEvent = {
  kind?: string;
  delta?: string;
  text?: string;
};

type ChatOptions = {
  onDelta?: (text: string) => Promise<void> | void;
};

const PROTOCOL_LEGACY_ACP = "legacy_acp";
const PROTOCOL_CODEX_APP_SERVER = "codex_app_server";

type AcpProtocol = typeof PROTOCOL_LEGACY_ACP | typeof PROTOCOL_CODEX_APP_SERVER;

function defaultWorkspace(): string {
  const dir = join(resolveConfigDir(), "workspace");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeArgs(args: unknown): string[] {
  return Array.isArray(args) ? args.map(String) : [];
}

function detectAcpProtocol(command: string, args: string[]): AcpProtocol {
  const base = basename(command).toLowerCase();
  if ((base === "codex" || base === "codex.exe") && args.includes("app-server")) {
    return PROTOCOL_CODEX_APP_SERVER;
  }
  return PROTOCOL_LEGACY_ACP;
}

function mergeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  if (!extra || Object.keys(extra).length === 0) return process.env;
  return { ...process.env, ...extra };
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractChunkText(update: SessionUpdate): string {
  if (typeof update.text === "string" && update.text) return update.text;

  const content = update.content;
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
  }

  return "";
}

function extractPromptResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;

  if (typeof record.text === "string") return record.text;

  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const part = entry as Record<string, unknown>;
        return part.type === "text" && typeof part.text === "string" ? part.text : "";
      })
      .join("");
  }

  return "";
}

function parsePermissionRequest(raw: string): { id: unknown; options: Array<Record<string, unknown>> } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const params = parsed.params as Record<string, unknown> | undefined;
    const options = Array.isArray(params?.options) ? params.options as Array<Record<string, unknown>> : [];
    return { id: parsed.id, options };
  } catch {
    return null;
  }
}

export class AcpAgent {
  private readonly command: string;
  private readonly args: string[];
  private readonly model: string;
  private readonly cwd: string;
  private readonly env?: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly protocol: AcpProtocol;

  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private nextId = 0;
  private stdoutBuffer = "";
  private stderrTail = "";

  private readonly sessions = new Map<string, string>();
  private readonly threads = new Map<string, string>();
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private readonly sessionUpdates = new Map<string, (update: SessionUpdate) => void>();
  private readonly turnUpdates = new Map<string, (event: CodexTurnEvent) => void>();

  constructor(config: AcpAgentConfig = {}) {
    this.command = config.command || "claude-agent-acp";
    this.args = normalizeArgs(config.args);
    this.model = config.model || "";
    this.cwd = config.cwd || defaultWorkspace();
    this.env = config.env;
    this.timeoutMs = config.timeoutMs ?? 1_800_000; // 30 minutes
    this.protocol = detectAcpProtocol(this.command, this.args);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  info(): Record<string, unknown> {
    return {
      type: "acp",
      command: this.command,
      args: this.args,
      model: this.model,
      cwd: this.cwd,
      protocol: this.protocol,
      pid: this.pid,
      started: this.started,
    };
  }

  async start(): Promise<void> {
    if (this.started && this.child && !this.child.killed) return;

    if (!existsSync(this.cwd)) mkdirSync(this.cwd, { recursive: true });

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: mergeEnv(this.env),
      stdio: "pipe",
      windowsHide: true,
    });
    this.started = true;

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    this.child.on("exit", (code, signal) => this.onExit(code, signal));
    this.child.on("error", (err) => this.rejectAll(new Error(`ACP subprocess error: ${err.message}`)));

    try {
      if (this.protocol === PROTOCOL_CODEX_APP_SERVER) {
        await this.rpc("initialize", { clientInfo: { name: "ocg", version: "1" } }, 30_000);
        await this.notify("initialized", undefined);
      } else {
        await this.rpc("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        }, 30_000);
      }
      console.log(`[ocg:acp] started ${this.command} pid=${this.pid ?? "?"} protocol=${this.protocol}`);
    } catch (err) {
      const detail = this.consumeStderrTail();
      this.stop();
      const hint = basename(this.command).toLowerCase().startsWith("claude") && basename(this.command).toLowerCase() !== "claude-agent-acp"
        ? " Hint: the Claude CLI usually does not speak ACP directly; use claude-agent-acp or configure HTTP mode."
        : "";
      throw new Error(`ACP initialize failed: ${detail || stringifyError(err)}.${hint}`);
    }
  }

  stop(): void {
    if (!this.child) return;
    this.started = false;
    this.sessions.clear();
    this.threads.clear();
    this.sessionUpdates.clear();
    this.turnUpdates.clear();
    this.rejectAll(new Error("ACP subprocess stopped"));
    try { this.child.stdin.end(); } catch { /* ignore */ }
    try { this.child.kill(); } catch { /* ignore */ }
    this.child = null;
  }

  resetSession(conversationId: string): void {
    this.sessions.delete(conversationId);
    this.threads.delete(conversationId);
  }

  async chat(conversationId: string, message: string, options: ChatOptions = {}): Promise<string> {
    await this.start();
    if (this.protocol === PROTOCOL_CODEX_APP_SERVER) {
      return this.chatCodexAppServer(conversationId, message, options);
    }
    return this.chatLegacyAcp(conversationId, message, options);
  }

  private async chatLegacyAcp(conversationId: string, message: string, options: ChatOptions): Promise<string> {
    const sessionId = await this.getOrCreateSession(conversationId);
    const parts: string[] = [];
    const updateQueue: SessionUpdate[] = [];
    let notify: (() => void) | undefined;

    this.sessionUpdates.set(sessionId, (update) => {
      updateQueue.push(update);
      notify?.();
    });

    try {
      const promptPromise = this.rpc("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: message }],
      }, this.timeoutMs);

      let promptSettled = false;
      let promptResult: unknown;
      let promptError: unknown;
      promptPromise.then((result) => {
        promptSettled = true;
        promptResult = result;
        notify?.();
      }).catch((err) => {
        promptSettled = true;
        promptError = err;
        notify?.();
      });

      while (!promptSettled || updateQueue.length > 0) {
        const update = updateQueue.shift();
        if (update) {
          if (update.sessionUpdate === "agent_message_chunk") {
            const text = extractChunkText(update);
            if (text) {
              parts.push(text);
              await options.onDelta?.(text);
            }
          }
          continue;
        }

        await new Promise<void>((resolve) => { notify = resolve; });
        notify = undefined;
      }

      if (promptError) throw promptError;

      let result = parts.join("").trim();
      if (!result) result = extractPromptResultText(promptResult).trim();
      if (!result) throw new Error("agent returned empty response");
      return result;
    } finally {
      this.sessionUpdates.delete(sessionId);
    }
  }

  private async getOrCreateSession(conversationId: string): Promise<string> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    const result = await this.rpc("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    }, this.timeoutMs) as Record<string, unknown>;

    const sessionId = typeof result.sessionId === "string" ? result.sessionId : "";
    if (!sessionId) throw new Error("session/new returned empty sessionId");
    this.sessions.set(conversationId, sessionId);
    return sessionId;
  }

  private async chatCodexAppServer(conversationId: string, message: string, options: ChatOptions): Promise<string> {
    const threadId = await this.getOrCreateThread(conversationId);
    const parts: string[] = [];
    const queue: CodexTurnEvent[] = [];
    let notify: (() => void) | undefined;
    let completed = false;
    let failed: Error | null = null;

    this.turnUpdates.set(threadId, (event) => {
      queue.push(event);
      notify?.();
    });

    this.rpc("turn/start", {
      threadId,
      approvalPolicy: "never",
      input: [{ type: "text", text: message }],
      sandboxPolicy: { type: "dangerFullAccess" },
      model: this.model || undefined,
      cwd: this.cwd,
    }, this.timeoutMs).catch((err) => {
      failed = err instanceof Error ? err : new Error(String(err));
      completed = true;
      notify?.();
    });

    try {
      while (!completed || queue.length > 0) {
        const event = queue.shift();
        if (event) {
          if (event.kind === "error") throw new Error(event.text || "turn error");
          const text = event.delta || event.text || "";
          if (text) {
            parts.push(text);
            await options.onDelta?.(text);
          }
          if (event.kind === "completed") completed = true;
          continue;
        }

        await new Promise<void>((resolve) => { notify = resolve; });
        notify = undefined;
      }

      if (failed) throw failed;
      const result = parts.join("").trim();
      if (!result) throw new Error("agent returned empty response");
      return result;
    } finally {
      this.turnUpdates.delete(threadId);
    }
  }

  private async getOrCreateThread(conversationId: string): Promise<string> {
    const existing = this.threads.get(conversationId);
    if (existing) return existing;

    const result = await this.rpc("thread/start", {
      approvalPolicy: "never",
      cwd: this.cwd,
      sandbox: "danger-full-access",
      model: this.model || undefined,
    }, this.timeoutMs) as Record<string, unknown>;

    const thread = result.thread as Record<string, unknown> | undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : "";
    if (!threadId) throw new Error("thread/start returned empty thread id");
    this.threads.set(conversationId, threadId);
    return threadId;
  }

  private rpc(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (!this.child || !this.started) return Promise.reject(new Error("ACP subprocess is not running"));

    const id = ++this.nextId;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const line = JSON.stringify(request) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(line, "utf8", (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private notify(method: string, params?: unknown): Promise<void> {
    if (!this.child || !this.started) return Promise.reject(new Error("ACP subprocess is not running"));
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    return new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(JSON.stringify(notification) + "\n", "utf8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleLine(line);
    }
  }

  private onStderr(chunk: string): void {
    const text = chunk.toString();
    this.stderrTail = (this.stderrTail + text).slice(-4000);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) console.warn(`[ocg:acp:stderr] ${line}`);
    }
  }

  private consumeStderrTail(): string {
    const tail = this.stderrTail.trim();
    this.stderrTail = "";
    return tail.split(/\r?\n/).filter(Boolean).slice(-3).join("; ");
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.started) return;
    this.started = false;
    this.rejectAll(new Error(`ACP subprocess exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch (err) {
      console.warn(`[ocg:acp] failed to parse JSON-RPC line: ${stringifyError(err)}`);
      return;
    }

    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (msg.error) {
        const detail = this.consumeStderrTail();
        pending.reject(new Error(detail || msg.error.message || "ACP agent error"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    switch (msg.method) {
      case "session/update":
        this.handleSessionUpdate(msg.params);
        break;
      case "session/request_permission":
      case "turn/approval/request":
        this.handlePermissionRequest(line);
        break;
      case "codex/event/agent_message_delta":
        this.handleCodexDelta(msg.params);
        break;
      case "item/agentMessage/delta":
        this.handleCodexItemDelta(msg.params);
        break;
      case "item/started":
        this.handleCodexItemStarted(msg.params);
        break;
      case "turn/completed":
        this.handleCodexTurnCompleted(msg.params);
        break;
      case "turn/started":
      case "codex/event/agent_message":
      case "codex/event/task_complete":
      case "codex/event/item_completed":
      case "codex/event/token_count":
      case "item/completed":
      case "thread/tokenUsage/updated":
      case "account/rateLimits/updated":
      case "thread/status/changed":
        break;
      default:
        if (msg.method) console.debug(`[ocg:acp] unhandled method: ${msg.method}`);
    }
  }

  private handleSessionUpdate(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const record = params as Record<string, unknown>;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
    const update = record.update as SessionUpdate | undefined;
    if (!sessionId || !update) return;
    this.sessionUpdates.get(sessionId)?.(update);
  }

  private handleCodexDelta(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const record = params as Record<string, unknown>;
    const msg = record.msg as Record<string, unknown> | undefined;
    const delta = typeof msg?.delta === "string" ? msg.delta : "";
    if (!delta) return;
    const key = typeof record.threadId === "string"
      ? record.threadId
      : typeof record.conversationId === "string"
        ? record.conversationId
        : "";
    this.dispatchTurnEvent(key, { delta });
  }

  private handleCodexItemDelta(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const record = params as Record<string, unknown>;
    const threadId = typeof record.threadId === "string" ? record.threadId : "";
    const delta = typeof record.delta === "string" ? record.delta : "";
    if (delta) this.dispatchTurnEvent(threadId, { delta });
  }

  private handleCodexItemStarted(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const record = params as Record<string, unknown>;
    const threadId = typeof record.threadId === "string" ? record.threadId : "";
    const item = record.item as Record<string, unknown> | undefined;
    if (item?.type !== "agentMessage" || !Array.isArray(item.content)) return;
    for (const part of item.content) {
      if (!part || typeof part !== "object") continue;
      const content = part as Record<string, unknown>;
      if (content.type === "text" && typeof content.text === "string" && content.text) {
        this.dispatchTurnEvent(threadId, { text: content.text });
      }
    }
  }

  private handleCodexTurnCompleted(params: unknown): void {
    const threadId = params && typeof params === "object" && typeof (params as Record<string, unknown>).threadId === "string"
      ? String((params as Record<string, unknown>).threadId)
      : "";
    this.dispatchTurnEvent(threadId, { kind: "completed" });
  }

  private dispatchTurnEvent(threadId: string, event: CodexTurnEvent): void {
    if (threadId && this.turnUpdates.has(threadId)) {
      this.turnUpdates.get(threadId)?.(event);
      return;
    }
    const first = this.turnUpdates.values().next().value as ((event: CodexTurnEvent) => void) | undefined;
    first?.(event);
  }

  private handlePermissionRequest(raw: string): void {
    const parsed = parsePermissionRequest(raw);
    if (!parsed) return;
    const allowOption = parsed.options.find((option) => option.kind === "allow") ?? parsed.options[0];
    const optionId = typeof allowOption?.optionId === "string" ? allowOption.optionId : "allow";
    const response = {
      jsonrpc: "2.0",
      id: parsed.id,
      result: {
        outcome: { outcome: "selected", optionId },
      },
    };
    try {
      this.child?.stdin.write(JSON.stringify(response) + "\n");
      console.log(`[ocg:acp] auto-allowed permission request`);
    } catch {
      // Best effort.
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

const agentPool = new Map<string, AcpAgent>();

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function getAcpAgent(config: AcpAgentConfig): AcpAgent {
  const key = stableStringify({
    command: config.command || "claude-agent-acp",
    args: normalizeArgs(config.args),
    model: config.model || "",
    cwd: config.cwd || defaultWorkspace(),
    env: config.env || {},
  });
  let agent = agentPool.get(key);
  if (!agent) {
    agent = new AcpAgent(config);
    agentPool.set(key, agent);
  }
  return agent;
}

export function stopAllAcpAgents(): void {
  for (const agent of agentPool.values()) agent.stop();
  agentPool.clear();
}

export function buildAcpConfigFromEnv(): AcpAgentConfig {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const prefix = "OCG_ACP_ENV_";
    if (key.startsWith(prefix) && typeof value === "string") {
      env[key.slice(prefix.length)] = value;
    }
  }

  return {
    command: process.env.OCG_ACP_COMMAND,
    args: process.env.OCG_ACP_ARGS ? JSON.parse(process.env.OCG_ACP_ARGS) as string[] : undefined,
    model: process.env.OCG_ACP_MODEL || process.env.OCG_MODEL,
    cwd: process.env.OCG_ACP_CWD || join(homedir(), ".openclaw-channel-gateway", "workspace"),
    env: Object.keys(env).length > 0 ? env : undefined,
    timeoutMs: process.env.OCG_ACP_TIMEOUT_MS ? Number(process.env.OCG_ACP_TIMEOUT_MS) : undefined,
  };
}
