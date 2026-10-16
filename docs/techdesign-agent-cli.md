# 技术设计：OCG Agent CLI（mailbox 传输 + daemon 薄客户端）

> 状态：**已实现（OCG `1.3.0`）；评审修订已落地（`1.3.1`）**
>
> 日期：2026-10-16
>
> 目标版本：OCG `1.3.0`（当前 `1.2.2`）
>
> 关联文档：`README.md`（CLI 命令 / 派发模式 / 主动发送）、`docs/requirements-proactive-send.md`（`/ocg/send` 与 `ocg send` 的契约，本文复用）、`CHANGELOG.md`
>
> 参考模型：browser-use CLI（常驻 daemon + 短命 CLI 命令 + `skill install`）

## 0. 决策摘要

| # | 决策点 | 结论 | 理由 |
| --- | --- | --- | --- |
| D1 | 产品形态 | **固定小词汇的 CLI**（`inbox / reply / send / targets / daemon / doctor / skill`），全部命令支持 `--json`；不采用 browser-use 的"stdin 喂 Python"模式 | IM 收发的动作空间很小，固定词汇对 LLM 更稳定、更容易写进 SKILL.md；Python 执行面带来的安全与依赖成本在这里没有收益 |
| D2 | 入站模型 | 新增第三种 agent 传输 `agentType: "mailbox"`，与 `http` / `acp` 并列。网关收到消息后**入队**并保留回复句柄，由 agent 用 CLI **拉取** | 现有两种传输都是推送式（§3.1），终端里的 coding agent 既不是 HTTP 服务器也不是 ACP 进程，没有任何办法读到消息。这是整个方案唯一的架构性新增 |
| D3 | CLI 与 daemon 的通信 | 复用现有回调服务器端口（默认 `3457`）走本地 HTTP；新增**本地 token 文件**鉴权（`X-OCG-Local-Token`），HMAC 方案原样保留给远程调用方 | 回调服务器已经在 daemon 内监听（§3.2），不再开第二个端口；agent 不应该为了本机调用去配置 HMAC 密钥 |
| D4 | 回复路径 | `ocg reply` **优先走回复句柄**（`registerDeliver` 的 token，即插件的被动回复通道），句柄过期后**降级为 `send`**，响应里用 `via` 字段标明 | 被动回复不受平台主动推送窗口限制（QQ 尤其明显，见 README「Platform push limits」）；降级让 agent 在超时后仍能把结果送出去 |
| D5 | 消费语义 | **竞争消费者 + 租约**（lease）：`inbox wait` 取走消息即持有租约，`reply` / `ack` 结束租约，租约超时后消息回到队列并计数 | 多个 agent / 子 agent 并行时不能抢同一条消息；租约比"读即删"安全，比"显式事务"简单 |
| D6 | 持久化 | 内存队列 + **追加式 JSONL** 日志（`<configDir>/mailbox/`）。daemon 重启后未完成的消息从 JSONL 重放，但回复句柄已失效，重放消息标记 `replyable: false` | 保持薄网关定位，不引入数据库；JSONL 同时承担 `inbox list --state done` 与审计 |
| D7 | daemon 生命周期 | 新增 `ocg daemon start/stop/status/logs`，是现有 `start -d / stop / status` 的别名与补全；**修复 `ocg stop` 不会结束后台进程的问题**（§3.4）。CLI 默认**不**自动拉起 daemon，可用 `--auto-start` 显式开启 | 启动网关有外部副作用（连接 IM 平台、Telegram 轮询冲突、扫码登录），不适合在一次 `inbox wait` 里隐式触发；browser-use 自动拉起的是无副作用的浏览器 |
| D8 | 技能分发 | `ocg skill install [--dir <path>]` 把 SKILL.md 写入 `~/.claude/skills/ocg/` 与 `./.agents/skills/ocg/`；`ocg skill show` 打印同一内容 | 与 browser-use 对齐；SKILL.md 随 npm 包发布，版本号跟随 OCG |
| D9 | 诊断 | `ocg doctor [--json]` 检查 Node 版本、配置文件、daemon 可达性、本地 token、各通道运行与登录状态、`agentType` 是否为 `mailbox` | agent 遇到任何失败时的第一步，减少无谓的重试 |
| D10 | MCP | **P0 不做**。daemon 客户端模块独立成 `src/daemon-client.ts`，后续 `ocg mcp` 直接复用 | CLI 跑通后 MCP 是薄壳；先验证 CLI 的交互模型 |

## 1. 背景与目标

### 1.1 背景

OCG 当前的定位是"IM 入站消息 → Agent API → 回复投递回 IM"。1.2.x 补上了反向的主动发送（`/ocg/send` 与 `ocg send`），但**入站方向只有推送式**：

```
IM 用户 → 插件 → OCG dispatch → POST agentUrl（http）
                              → ACP 子进程 session/prompt（acp）
```

一个在终端里运行的 coding agent（Claude Code、Codex、OpenCode）希望像使用 browser-use 那样，用几条 shell 命令完成"等一条消息 → 处理 → 回复"的循环。今天它只能被推送，不能主动"拿"。

### 1.2 browser-use CLI 的要素与 OCG 现状对照

| browser-use 要素 | OCG 现状 | 本设计 |
| --- | --- | --- |
| 后台 daemon 持有状态 | `ocg start -d`，PID 写入 `ocg-state.json` | `ocg daemon *`，修复 stop |
| CLI 作为 daemon 薄客户端 | 回调服务器已监听，但 `ocg send` 在独立进程里重新加载插件 | 所有读写命令优先经 daemon HTTP；daemon 不在时按命令决定回退或报错 |
| 读取输入 | **无** | `inbox wait / list / ack`（D2、D5） |
| 执行动作 | `ocg send --json`，退出码 0/1/2/3 | 新增 `reply`，`send` 改走 daemon |
| 并行隔离（命名 session） | 无 | `--consumer <name>` + 租约（D5） |
| `skill install / show` | 无 | D8 |
| `--doctor` | 无 | D9 |
| 结构化输出 | 仅 `send` / `status` / `channels` 有 `--json` | 全部命令统一 `--json` 与错误结构（§5.7） |

### 1.3 目标

1. 一个 agent 只凭 SKILL.md 和 `ocg --help` 就能完成：确认 daemon 在跑 → 等消息 → 回复 → 必要时主动发送。
2. 每条命令在 daemon 运行时 **< 200 ms** 返回（不含 `inbox wait` 的等待本身）。
3. 不改变现有 `http` / `acp` 用户的任何行为；新增配置全部可选。

### 1.4 非目标

- 不做消息重试、定时发送、广播（沿用 proactive send 的 D6）。
- 不做对话历史存储与检索；agent 自行按 `sessionKey` 维护记忆。
- 不做流式回复到 IM（`reply --partial`）；列入 P2。
- 不做 Web UI、不做远程多机 daemon 发现。
- P0 不做 MCP server（D10）。

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| daemon | 以 `ocg start -d` / `ocg daemon start` 启动的后台网关进程，持有通道连接与回调服务器 |
| mailbox | 新增传输类型；入站消息进入 daemon 内的队列，等待 CLI 拉取 |
| consumer | 拉取消息的一方的名字（一个 agent 或子 agent），用于租约归属 |
| lease（租约） | consumer 取走消息后对它的临时独占；`reply` / `ack` 结束，超时自动释放 |
| reply handle（回复句柄） | `registerDeliver` 返回的 token 所对应的 `deliver` 函数，即插件的被动回复通道 |
| target | 平台侧收件目标，插件规范化格式（如 `qqbot:c2c:<openid>`），与 `X-OCG-Target` 同源 |
| local token | daemon 启动时生成、写在配置目录的随机密钥，供本机 CLI 鉴权 |

## 3. 现状证据（代码定位）

> 以下为 1.2.2 的代码事实，实现时以最新代码为准。

### 3.1 入站派发有两个入口，都按 `agentType` 分支

- `src/shims/reply-dispatch-runtime.ts` 的 `httpDispatch`：Telegram / Discord / qqbot 等走 `dispatchReplyWithBufferedBlockDispatcher` 的插件进入这里。先 `acp` 分支，再 `async` 分支，最后同步 HTTP。
- `src/shims/runtime.ts` 的 `dispatchReplyFromConfig`：openclaw-weixin 等通过 `channelRuntime.reply.dispatchReplyFromConfig` 进入这里，逻辑与上面高度重复（模型解析、verbose 日志、ACP 分支都复制了一份）。

**结论**：`mailbox` 分支如果再复制一次，三种传输 × 两个入口的组合会失控。本设计把"从 ctx 抽取入站消息 + 选择传输"抽成一个共享函数（§5.2），两个入口都调用它。

### 3.2 回调服务器已具备"回复句柄"与本地 HTTP 面

- `src/callback-server.ts`：`registerDeliver(deliver, ttlMs)` 返回 64 位 hex token，TTL 到期自动清理；`POST /ocg/callback/{token}` 消费它并投递；`POST /ocg/send` 以 HMAC 鉴权。路由是 `createServer` 回调里的一串正则判断，没有路由表。
- `deliver(payload, meta)` 的 `payload` 只认 `text` / `isError`；回调路径的结构化 `reply` 也只取 `text`（`callback-server.ts` 第 376-386 行）。媒体只能通过 qqbot 的本地路径重写（`rewriteLocalMediaPathsForDelivery`）夹在文本里。

**结论**：`inbox` / `reply` 路由可以直接加在这个 server 上，但要先把路由判断整理成一张小表；`reply` 的媒体能力受 `deliver` 限制（§5.5）。

### 3.3 入站上下文可用字段

OpenClaw 插件在 ctx 中提供（`node_modules/openclaw/dist/plugin-sdk/*.d.ts`）：`Body` / `BodyForAgent` / `RawBody`、`From`、`SessionKey`、`SenderId` / `SenderName`、`ChatType`、`GroupSubject`、`MessageSid`、`ReplyToId`、`Timestamp`、`WasMentioned`、`MediaPath(s)` / `MediaUrl(s)` / `MediaType(s)`、`OriginatingChannel` / `OriginatingTo`。OCG 现在只用了 `Body*`、`From`、`SessionKey` 和 `channelId`。

### 3.4 daemon 控制面的缺口

- `ocg stop`（`src/cli.ts` `cmdStop`）调用 `stopGateway()`，只停**当前进程内**的通道，然后 `clearGatewayProcessState(process.pid)`，而状态文件里的 pid 是后台进程的，所以**既不杀后台进程，也不清状态文件**。后台模式下 `ocg stop` 实际上是空操作。
- `ocg status` 通过状态文件 + `process.kill(pid, 0)` 判断存活，没有 HTTP 健康检查，无法区分"进程在但回调服务器没起来"。
- `ocg send` 在自己的进程里 `ensureChannelPluginLoaded`，加载插件通常要 1-3 秒，并且与 daemon 不共享账号运行态（README 已明确提示）。

### 3.5 CLI 骨架

`src/cli.ts` 自带 `parseArgs`（无 Commander），命令分发是一串 `if (command === ...)`，子命令以空格拼接（`channels list`）。新命令按同样方式接入即可，不引入依赖。

## 4. 总体架构

```
┌──────────────────────── daemon（ocg start -d）────────────────────────┐
│                                                                        │
│  IM 插件 ─► dispatch 入口 ─► dispatchInbound()                         │
│                               ├─ http    → POST agentUrl（不变）        │
│                               ├─ acp     → ACP 子进程（不变）            │
│                               └─ mailbox → Mailbox.enqueue(msg, deliver)│
│                                                ▲          │             │
│  回调服务器 :3457                                │          ▼             │
│   POST /ocg/callback/{token}（不变）             │     JSONL append       │
│   POST /ocg/send（HMAC，不变）                   │                         │
│   GET  /ocg/health                     ┌────────┴──────────┐            │
│   GET  /ocg/inbox/wait                 │  Mailbox          │            │
│   GET  /ocg/inbox                      │  pending / leased │            │
│   POST /ocg/inbox/{id}/ack             │  / done           │            │
│   POST /ocg/inbox/{id}/reply ──────────┤  replyHandle(id)  │──► deliver │
│   GET  /ocg/targets                    └───────────────────┘            │
│   （以上新路由：X-OCG-Local-Token 或 HMAC）                               │
└────────────────────────────────────────────────────────────────────────┘
          ▲ 本地 HTTP（daemon-client.ts）
          │
┌─────────┴─────────┐
│ ocg CLI（短命进程） │  inbox wait / reply / send / targets / daemon / doctor / skill
└───────────────────┘
          ▲
          │ shell
   coding agent（读 ~/.claude/skills/ocg/SKILL.md）
```

## 5. 详细设计

### 5.1 模块划分

| 文件 | 职责 | 预估行数 |
| --- | --- | --- |
| `src/inbound.ts`（新） | `extractInboundMessage(ctx)`：从插件 ctx 规范化出 `InboundMessage`（§5.3）；`dispatchInbound()`：按 `agentType` 选择传输，供两个 dispatch 入口调用 | ~150 |
| `src/mailbox.ts`（新） | 队列、租约、consumer、JSONL 持久化、长轮询等待者管理、`replyHandle` 保管 | ~350 |
| `src/local-auth.ts`（新） | 本地 token 的生成 / 读取 / 校验（§5.9） | ~60 |
| `src/agent-routes.ts`（新） | `/ocg/health` `/ocg/inbox*` `/ocg/targets` 路由处理；统一错误结构 | ~250 |
| `src/daemon-client.ts`（新） | CLI 侧 HTTP 客户端：发现端口、附带 token、超时、错误映射为退出码 | ~120 |
| `src/daemon-control.ts`（新） | 结束后台进程（跨平台）、读日志路径、健康探测 | ~100 |
| `src/skill-template.ts`（新） | SKILL.md 文本（模板字符串，带版本号） | ~120 |
| `src/callback-server.ts`（改） | 路由表化；挂接 `agent-routes`；在 `/ocg/send` 上接受 local token | +60 |
| `src/shims/reply-dispatch-runtime.ts` / `src/shims/runtime.ts`（改） | 删除重复的传输选择逻辑，改调 `dispatchInbound` | −150 / +20 |
| `src/config.ts`（改） | `AgentType` 加 `mailbox`；新增 `mailbox*` 配置键（§5.13） | +40 |
| `src/cli.ts`（改） | 新命令；`send` / `status` 优先走 daemon；统一 `--json` 输出 | +350 |
| `src/mailbox-test.ts` / `src/agent-routes-test.ts`（新） | 单测 / 路由测试，风格同 `send-test.ts` | ~500 |

### 5.2 mailbox 传输的派发流程

```ts
// src/inbound.ts
export async function dispatchInbound(params: {
  ctx: Record<string, unknown>;
  cfg: Record<string, unknown>;
  deliver?: DeliverFn;
  beforeDeliver?: BeforeDeliverFn;
  onModelSelected?: (model: string) => Promise<void>;
}): Promise<DispatchResult>
```

1. `extractInboundMessage(ctx)` 得到 `InboundMessage`（§5.3）；正文为空且无媒体时直接返回 `queuedFinal:false`（与现有行为一致）。
2. `resolveChannelAgentType(channelId, cfg)` 返回 `"mailbox"` 时：
   - 如有 `deliver`，`registerDeliver(deliver, mailboxReplyTTL)` 得到回复 token；
   - `Mailbox.enqueue(msg, { replyToken, expiresAt })`；
   - 唤醒匹配的长轮询等待者；
   - 日志一行 `[ocg:mailbox] enqueued id=… channel=… target=…`；
   - 返回 `{ queuedFinal: false, mailbox: true, messageId }`。
3. `"http"` / `"acp"` 分支保留现有实现，只是从两个 shim 挪到这里一份。

`onModelSelected` 在 mailbox 模式**不调用**：它在部分插件上触发"正在输入"指示，而 agent 可能几分钟后才处理。P1 评估在 `inbox wait` 取走消息时触发一次。

`async: true` 与 `mailbox` 互斥：`mailbox` 优先，启动时打印警告。

### 5.3 消息模型

```ts
export type InboundMessage = {
  id: string;                 // "m_" + 时间有序随机串（ULID 风格），全局唯一
  channel: string;            // 插件 id，如 "qqbot"
  accountId: string;          // 默认 "default"
  target: string | null;      // ctx.From 规范化目标；未知为 null（此时不可 send 降级）
  sessionKey: string;         // ctx.SessionKey，agent 侧记忆的键
  chatType: "direct" | "group" | "channel" | "unknown";
  sender: { id: string | null; name: string | null };
  groupSubject: string | null;
  text: string;               // BodyForAgent ?? Body ?? CommandBody ?? RawBody
  media: Array<{ path: string | null; url: string | null; mime: string | null }>;
  platformMessageId: string | null;   // ctx.MessageSid
  replyToId: string | null;
  wasMentioned: boolean | null;
  receivedAt: number;         // epoch ms
};

export type MailboxEntry = InboundMessage & {
  state: "pending" | "leased" | "done";
  consumer: string | null;    // 当前租约持有者
  leaseExpiresAt: number | null;
  redeliveries: number;       // 租约超时次数
  replyable: boolean;         // 回复句柄仍有效
  replyExpiresAt: number | null;
  doneBy: "reply" | "ack" | "expired" | null;
  doneAt: number | null;
};
```

对 agent 输出时省略 `replyToken` 等内部字段；`text` 不截断。

### 5.4 消费语义：consumer 与租约

- `GET /ocg/inbox/wait?consumer=<name>&timeoutMs=<n>[&channel=<id>][&max=<k>]`：
  - 立即返回最早的 `pending` 消息（最多 `max`，默认 1），并置为 `leased`、记录 `consumer` 和 `leaseExpiresAt = now + mailboxLeaseMs`；
  - 没有则挂起最长 `timeoutMs`（默认 60 000，上限 120 000，服务端 `requestTimeout` 已足够），到时返回 `{"ok":true,"messages":[]}`，**HTTP 200、CLI 退出码 0**。agent 的循环不需要把"没消息"当成错误；
  - `channel` 过滤只影响该等待者；
  - 可选 `peek=1`：只读不租。
- `POST /ocg/inbox/{id}/ack`：结束租约，`state=done, doneBy=ack`。消费者不是租约持有者时返回 `409 LEASE_HELD_BY_OTHER`，可用 `force=1` 覆盖（供人工处理）。
- `POST /ocg/inbox/{id}/reply`：成功即 `done, doneBy=reply`。
- 租约到期：后台定时器（每 5 s）把超时的 `leased` 改回 `pending`，`redeliveries++`；超过 `mailboxMaxRedeliveries`（默认 5）后置为 `done, doneBy=expired` 并打印警告。
- `consumer` 缺省取 `OCG_CONSUMER` 环境变量，再缺省为 `"default"`。SKILL.md 建议并行 agent 各自取名。
- 队列上限 `mailboxMaxPending`（默认 1000），满了丢弃最老的 `pending` 并记录。

同一 `sessionKey` 的消息不做顺序保证。P1 可加 `--session <key>` 过滤让一个 agent 专注一个会话。

### 5.5 回复：句柄优先，过期降级

```
POST /ocg/inbox/{id}/reply   body: { text?: string, mediaUrl?: string, isError?: boolean }
```

1. 查找 entry；不存在 → `404 NOT_FOUND`；`done` 且 `doneBy=reply` → `409 ALREADY_REPLIED`。
2. `replyable` 为真：取 `replyHandle`，用 `deliverPayloadInChunks(deliver, { text, isError }, { kind: "final" }, replyChunkSize)` 投递（与 `/ocg/callback` 完全相同的路径），响应 `via: "reply"`。
   - `mediaUrl`：当前 `deliver` 只认文本（§3.2）。P0 行为是 qqbot 把本地路径按现有 `rewriteLocalMediaPathsForDelivery` 规则并入文本；其他通道若带 `mediaUrl` 则**直接走降级路径**（`send` 的 `sendMedia` 原语），响应 `via: "send"`，并在 `notes` 里说明。
3. `replyable` 为假（句柄过期或 daemon 重启后重放）：
   - `target` 为 null → `410 REPLY_EXPIRED`，不可降级；
   - 否则调用 `executeSend({ channel, accountId, to: target, text, mediaUrl })`（`src/send-service.ts`，直接传入 daemon 已加载的插件），响应把 `executeSend` 的结果原样嵌入 `send` 字段，`via: "send"`。降级受 `sendAllowedChannels` 约束，但**不要求** `sendSecret`（调用方已通过 local token 鉴权）。
4. 成功后 entry 置 `done`，JSONL 追加 `{type:"reply", id, via, ok, elapsedMs}`。

### 5.6 HTTP 接口契约（新增部分）

所有新路由接受两种鉴权之一：`X-OCG-Local-Token: <token>`（§5.9）或既有 `X-OCG-Signature`（HMAC，使用 `sendSecret` / `callbackSecret`）。两者都没有 → `401 UNAUTHORIZED`。

| 方法 / 路径 | 说明 | 成功响应 |
| --- | --- | --- |
| `GET /ocg/health` | daemon 存活与能力 | `{ ok, version, pid, uptimeMs, agentType, mailbox: { enabled, pending, leased }, channels:[{id, accountId, status}] }` |
| `GET /ocg/inbox/wait` | 长轮询取消息（§5.4） | `{ ok, consumer, messages: InboundMessage[], leaseExpiresAt }` |
| `GET /ocg/inbox?state=pending,leased,done,all&limit=50&since=<ms>` | 列表（`done` 从 JSONL 读） | `{ ok, entries: MailboxEntry[] }` |
| `GET /ocg/inbox/{id}` | 单条详情 | `{ ok, entry }` |
| `POST /ocg/inbox/{id}/ack` | 结束租约 | `{ ok, id, state:"done" }` |
| `POST /ocg/inbox/{id}/reply` | 回复（§5.5） | `{ ok, id, via:"reply" or "send", chunks, elapsedMs, send?, notes? }` |
| `GET /ocg/targets?channel=<id>&limit=50` | 最近出现过的对端（从 mailbox 入站聚合，含 `lastSeenAt`、`sender`、`chatType`） | `{ ok, targets:[…] }` |
| `POST /ocg/send` | 既有；新增接受 local token | 不变 |

错误响应统一为 `{ ok:false, code, message, hint? }`。新增 `code`：`UNAUTHORIZED`、`MAILBOX_DISABLED`（`agentType` 不是 mailbox 且无任何 mailbox 通道）、`NOT_FOUND`、`LEASE_HELD_BY_OTHER`、`ALREADY_REPLIED`、`REPLY_EXPIRED`、`INVALID_REQUEST`。`reply` 降级时沿用 `send` 的错误码（`PLATFORM_SEND_FAILED` 等）。

CORS 头保持现状；新路由同样允许 `X-OCG-Local-Token`。

### 5.7 CLI 契约

全局约定：

- `--json` 输出单个 JSON 对象（成功 `ok:true`，失败 `ok:false` + `code` + `message` + `hint`），人类可读模式输出等价文本；
- 退出码沿用 `send`：`0` 成功 / `1` 平台或投递失败 / `2` 参数错误 / `3` daemon 不可用、鉴权失败、能力关闭；
- 环境变量：`OCG_CONSUMER`、`OCG_DAEMON_URL`（覆盖端口发现）、`OCG_AUTO_START`。

| 命令 | 行为 | 走 daemon？ |
| --- | --- | --- |
| `ocg daemon start [--log-dir]` | 等价 `ocg start -d`；启动后轮询 `/ocg/health` 最多 30 s，就绪后退出 0 并打印 `{pid, port, channels}` | 启动它 |
| `ocg daemon stop [--timeout 10]` | 读状态文件 pid，SIGTERM（Windows 用 `taskkill /PID /T`），等待退出，清状态文件；无进程则退出 0 并提示 | — |
| `ocg daemon status [--json]` | `/ocg/health` 结果；不可达时回落到状态文件并标记 `reachable:false` | 是 |
| `ocg daemon logs [--tail 100] [--follow]` | 打印最近日志文件（`~/.openclaw-channel-gateway/ocg.logs/`） | — |
| `ocg inbox wait [--timeout 60] [--channel] [--consumer] [--max 1] [--peek] --json` | 见 §5.4；超时返回空数组、退出 0 | 必须 |
| `ocg inbox list [--state pending] [--limit 50] --json` | 列表 | 必须 |
| `ocg inbox show <id> --json` | 详情（含完整文本与媒体路径） | 必须 |
| `ocg inbox ack <id> [--force]` | 结束租约 | 必须 |
| `ocg reply <id> (--text <t> / --text-file <path> / -) [--media <url-or-path>] [--error] --json` | §5.5；`-` 表示从 stdin 读正文（长回复不受命令行长度限制） | 必须 |
| `ocg send …`（既有） | daemon 可达时改为调用 `/ocg/send`（带 local token），否则保持现有进程内实现并在输出里标 `inProcess:true` | 优先 |
| `ocg targets list [--channel] --json` | 最近对端 | 必须 |
| `ocg doctor [--json]` | §5.11 | 尽量 |
| `ocg skill install [--dir <path>] [--force]` / `ocg skill show` | §5.10 | — |
| `ocg status`（既有） | 合并 `/ocg/health` 信息 | 优先 |

"必须"类命令在 daemon 不可达时：若 `--auto-start` 或 `OCG_AUTO_START=1`，先执行 `daemon start` 再重试一次；否则输出 `{ok:false, code:"DAEMON_NOT_RUNNING", hint:"run: ocg daemon start"}` 退出 3。

`ocg stop` / `ocg restart` 在后台模式下改为调用 `daemon stop`（修复 §3.4）。

### 5.8 daemon 生命周期细节

- **端口发现**：daemon 启动后把实际绑定端口写进 `ocg-state.json`（新增 `callbackPort` 字段）；CLI 读取它，再被 `OCG_DAEMON_URL` 覆盖。
- **就绪判定**：`/ocg/health` 返回 200 且 `channels` 中至少一个 `running`，或超过 30 s 后只要 200 也算就绪（通道登录可能慢）。
- **停止**：`daemon-control.stopDaemon(pid)`：POSIX `process.kill(pid, "SIGTERM")`；Windows `taskkill /PID <pid> /T /F`（Node 在 Windows 上收不到 SIGTERM 做优雅退出，接受这一点，租约状态在 JSONL 里）。daemon 进程内加 `SIGTERM` / `SIGINT` 处理：`stopGateway()` → flush JSONL → 退出。
- **单实例**：`startGateway` 时若状态文件 pid 仍存活且 `/ocg/health` 可达，拒绝启动并退出 3（避免双实例抢 Telegram 轮询）。

### 5.9 本地鉴权

- daemon 启动时若 `<configDir>/ocg-local-token` 不存在，生成 32 字节随机 hex 写入，POSIX 下 `chmod 600`；Windows 依赖用户目录 ACL。
- `callback-server` 读取该文件内容进内存；新路由与 `/ocg/send` 在校验 HMAC 之前先用 `timingSafeEqual` 比对 `X-OCG-Local-Token`。
- `callbackHost` 为 `0.0.0.0` 时（默认），local token 的路由只接受来自回环地址的连接（检查 `req.socket.remoteAddress`），避免 token 泄漏后被局域网内直接使用；HMAC 路径不受此限制。
- `ocg doctor` 检查文件存在且与 daemon 内存一致（通过 `/ocg/health` 的 200/401）。

### 5.10 skill 分发

`ocg skill install`：

- 目标目录依次为 `~/.claude/skills/ocg/`、`./.agents/skills/ocg/`（当前目录存在 `.agents/` 时）、`--dir` 指定目录；
- 写入 `SKILL.md`，已存在且内容不同时需 `--force`，否则提示并退出 0；
- `ocg skill show` 把同一内容打印到 stdout。

SKILL.md 大纲（frontmatter `name: ocg`，`description` 一句话说明何时使用）：

1. 一句话定位与前置条件（`ocg doctor`、`ocg daemon start`）；
2. 核心循环，四行命令：`inbox wait` → 读 JSON → 处理 → `reply <id> -`；
3. 消息 JSON 字段说明，强调 `id`、`sessionKey`、`target`、`media[].path`、`replyExpiresAt`；
4. 并行规则：子 agent 设 `OCG_CONSUMER`；
5. 主动发送与 `targets list`；
6. 退出码与错误码速查；
7. 平台限制（QQ 主动窗口、Telegram 需用户先发起）与"回复优先于 send"的理由；
8. 禁止事项：不要 `ocg daemon stop` 用户的 daemon 除非被要求；不要自行重试平台错误。

### 5.11 doctor 检查项

| 检查 | 失败提示 |
| --- | --- |
| Node >= 22.12 | 升级 Node |
| 配置文件存在、JSON 合法 | 给出路径与 `ocg.example.json` |
| 至少一个通道启用 | `ocg channels add …` |
| `agentType`（全局或任一通道）为 `mailbox` | 说明 `inbox` 需要 mailbox 模式及如何设置 |
| 状态文件 pid 存活 | `ocg daemon start` |
| `/ocg/health` 200 | 端口冲突 / 防火墙 / `OCG_DAEMON_URL` |
| local token 校验通过 | 删除 token 文件并重启 daemon |
| 各通道 `running` | `ocg channels login` / 查看 `daemon logs` |
| mailbox 积压（`pending` > 100 或最老消息 > 10 min） | 警告 |

### 5.12 入站媒体

- 插件已给本地路径（`MediaPath(s)`）：原样记录。
- 只有 `MediaUrl(s)`：`mailboxDownloadMedia`（默认 `true`）为真时，入队后异步下载到 `<configDir>/mailbox/media/<id>/<n>.<ext>`，完成后更新 `media[n].path`；`inbox wait` 返回时若尚未下载完，`path` 为 null、`url` 保留，agent 可用 `inbox show` 再查。
- 媒体目录按 `mailboxMediaRetentionDays`（默认 7）清理。

### 5.13 配置（全部可选）

```jsonc
{
  "agentType": "mailbox",             // 或在 channels.<id>.agentType 上按通道设置
  "mailboxLeaseMs": 300000,           // 租约时长，默认 5 分钟
  "mailboxReplyTTL": 1800,            // 回复句柄 TTL（秒），缺省沿用 callbackTokenTTL
  "mailboxMaxPending": 1000,
  "mailboxMaxRedeliveries": 5,
  "mailboxDownloadMedia": true,
  "mailboxMediaRetentionDays": 7,
  "mailboxHistoryRetentionDays": 30,  // JSONL 滚动保留（时间上限）
  "mailboxMaxDone": 2000              // 内存/快照中的 done 条目数量上限（1.3.1；-1 不限）
}
```

`AgentType` 扩为 `"http" | "acp" | "mailbox"`；`resolveChannelAgentType` 的两处字面量判断改为集合判断。`gatewayStatus()` 的 `agentUrl` 在 mailbox 模式显示 `mailbox://local`。

## 6. 安全

- 新路由默认只对回环地址开放 local token 鉴权（§5.9）；远程调用方继续用 HMAC。
- `reply` 的降级发送不要求 `sendSecret`，但受 `sendAllowedChannels`、`sendMaxTextLength` 约束，且只能发往该消息自己的 `target`，不能改目标。
- `inbox` 的输出包含用户消息原文与媒体路径，SKILL.md 提醒 agent 不要把它写进公共仓库或日志。
- JSONL 与媒体落在用户配置目录；不新增网络外发。
- token 文件、JSONL、媒体目录都在 `~/.openclaw-channel-gateway/` 下，`ocg doctor` 不打印 token 内容。

## 7. 兼容性

- 不设置 `agentType: "mailbox"` 的用户：新路由返回 `MAILBOX_DISABLED`，其余行为与 1.2.2 完全一致；`ocg send` 多了"优先走 daemon"但结果字段向后兼容（新增 `inProcess`）。
- `ocg stop` 行为变化：后台模式下现在真的会结束进程。记入 CHANGELOG 的 Changed。
- 两个 dispatch 入口合并到 `dispatchInbound` 是纯重构，用现有 `dispatch-test.ts` / `acp-dispatch-test.ts` 回归。

## 8. 测试计划

| 层 | 用例 |
| --- | --- |
| `mailbox-test.ts` | 入队唤醒等待者；超时返回空；租约到期回队列并计数；超过上限置 expired；`channel` 过滤；`peek` 不租；JSONL 重放后 `replyable=false`；队列满丢最老 |
| `agent-routes-test.ts` | 401 无鉴权；local token 非回环拒绝；HMAC 通过；`wait` 长轮询在 1 s 内被 enqueue 唤醒；`reply` 走句柄 vs 降级 `send`（mock 插件，复用 `send-test.ts` 的 fixture）；`ALREADY_REPLIED`；`LEASE_HELD_BY_OTHER` 与 `force` |
| `inbound` 重构回归 | 现有 `dispatch-test.ts`、`acp-dispatch-test.ts` 全绿；两个入口对同一 ctx 产生相同 `InboundMessage` |
| CLI 端到端（手动 + `scripts/`） | `daemon start` → `inbox wait` 阻塞 → 用 mock 插件投一条消息 → 返回 → `reply` → `inbox list --state done`；`daemon stop` 后 `inbox wait` 退出 3 且 hint 正确；Windows 与 POSIX 各跑一遍 |
| 真实通道冒烟 | qqbot c2c：收 → `reply` 走句柄成功；等待超过 `mailboxReplyTTL` 后 `reply` 降级为 `send` 并返回平台窗口错误原文 |

## 9. 分阶段交付

| 阶段 | 内容 | 产出 | 估算 |
| --- | --- | --- | --- |
| P0-a | `dispatchInbound` 重构；`AgentType` 加 `mailbox`；`callback-server` 路由表化；local token；`/ocg/health`；`daemon start/stop/status/logs`；修复 `stop` | 1.3.0-alpha.1 | 2 天 |
| P0-b | `mailbox.ts` + `inbox*` / `reply` / `targets` 路由 + 对应 CLI；JSONL；媒体下载 | 1.3.0-alpha.2 | 3 天 |
| P0-c | `doctor`、`skill install/show`、SKILL.md、README 两份、CHANGELOG；`send` 优先走 daemon | 1.3.0 | 1.5 天 |
| P1 | `--session` 过滤；按通道路由到固定 consumer（`mailboxRouting`）；`inbox wait` 时触发"正在输入" | 1.3.x | 1 天 |
| P2 | `reply --partial` 流式；`ocg mcp` | 1.4.0 | 待定 |

## 10. 风险与未决问题

| # | 风险 / 问题 | 应对 |
| --- | --- | --- |
| R1 | 两个 dispatch 入口在 ctx 字段上有细微差异（weixin 入口的 `From` / `SessionKey` 组装可能不同），合并后目标解析出错 | 重构前先用日志采样两种入口的 ctx 键集合，`extractInboundMessage` 对缺失字段返回 null 而不是猜 |
| R2 | Windows 上 `taskkill /F` 无法优雅退出，租约状态与 JSONL 可能不同步 | JSONL 每次状态变化同步 `appendFileSync`；重放时以最后一条记录为准 |
| R3 | 长轮询连接被代理 / 防火墙提前断开 | 服务端每 15 s 发一个空白字符保活，客户端收到非 JSON 前缀时忽略；超时上限 120 s |
| R4 | agent 持有租约后崩溃，消息 5 分钟内不可见 | 文档说明；`inbox list --state leased` 与 `ack --force` 供人工介入；`mailboxLeaseMs` 可调 |
| R5 | 媒体异步下载让 `wait` 返回的 `path` 为 null，agent 可能忽略媒体 | SKILL.md 明确：`path` 为 null 时用 `inbox show <id>` 重查，或读 `url` |
| Q1 | `targets list` 是否也要纳入 `http` / `acp` 模式的入站记录（目前只在 mailbox 入队时记录） | 倾向于是：记录成本极低，而 `send` 在所有模式下都需要可用目标。P0 先只做 mailbox，P1 扩展 |
| Q2 | `reply` 是否允许多次（同一消息分多条回复） | P0 不允许（`ALREADY_REPLIED`），分多条用 `send`；收集反馈后再定 |
| Q3 | SKILL.md 是否随 npm 包以独立文件发布（`files` 加 `skills/`），供 `npx skills add` 一类工具直接抓取 | 倾向于是，与 `ocg skill show` 内容同源，构建时生成 |

## 11. 变更记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v0.1 | 2026-10-16 | 初稿 |
| v0.2 | 2026-10-16 | 实现落地（1.3.0）；§12 记录实现注记与偏差 |
| v0.3 | 2026-10-16 | 评审修订（1.3.1）：§13 |

## 12. 实现注记（1.3.0）

实现过程中确认或调整的点，均以代码为准：

1. **两个 dispatch 入口的投递语义不同**（§5.2 的"纯重构"隐含冲突）。`reply-dispatch-with-buffered-block-dispatcher` 入口在流式时块 + 最终回复都投递（`dispatch-test.ts` 断言）；`dispatchReplyFromConfig` 入口在块投递后跳过最终、空正文直接跳过，且 `disableBlockStreaming` 只在该入口被读取。`dispatchInbound` 因此保留两个显式选项（`finalPolicy: "always" | "unless-blocks"`、空正文由各入口自行前置处理），两个入口行为与 1.2.2 逐项一致（`acp-dispatch-test` 的旧期望在 HEAD 上即失败，属测试缺陷，已补 `acpStreamBlocks: true` 修正）。
2. **回复句柄不经 token 注册表**（§5.5 原文 "取 registerDeliver 的 token"）。`registerDeliver` 只提供破坏性的 `consumeDeliver`，且 token 只是间接层；mailbox 直接保管 deliver 函数 + 过期时间，语义不变（消费即失效、重启即失效 → 降级 send）。
3. **`reply` 在 `ack` / `expired` 之后仍允许回复**（文档只定义了 `doneBy=reply` 的 `ALREADY_REPLIED`），成功后翻转 `doneBy=reply`；`force=1` 同时适用于 `reply`（不止 `ack`），供人工介入。
4. **`ocg-state.json` 记录 `callbackHost`**（文档只写了 `callbackPort`）：绑定到具体网卡时 CLI 无法用 127.0.0.1 连接，必须按 host 发现。
5. **路径派生统一跟随 `OCG_CONFIG_PATH`**：状态文件、`ocg.logs/`、`ocg-local-token`、`mailbox/` 全部放在 `dirname(configPath)`（测试与多实例隔离；默认仍是 `~/.openclaw-channel-gateway`）。
6. **daemon 就绪窗口**（§5.8 "最多 30 s"）：实测冷启动仅插件加载就 ~73 s，30 s 窗口必然误报超时。实现为：健康 200 且（有通道 running 或已等待 ≥30 s）→ 就绪；上限 `--timeout`（默认 120 s）。
7. **`/ocg/send` 的无 secret 门槛不变**：local token 只解决鉴权（D3），不会绕过 `403 DISABLED`——与进程内 `ocg send` 行为保持一字不差；只有 `reply` 的降级路径按 §5.5 豁免 `sendSecret`。
8. **`targets` 从 JSONL 重放重建**：daemon 重启后 `ocg targets list` 仍可用（原设计未明确持久性）。
9. **HMAC 对 GET 路由签空 body**（`sha256=<HMAC("")>`），POST 路由签原始字节；`/ocg/callback` 行为完全不变。
10. **`ocg send` 走 daemon 时 `--chunk-prefix` 不适用**（HTTP 契约无此字段）：带该 flag 时直接走进程内实现。

## 13. 评审修订（1.3.1）

1.3.0 评审（见 CHANGELOG 1.3.1）发现的问题与处理：

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | HMAC 对 GET 路由只签空 body，`sha256=HMAC("")` 等于一个永久只读 bearer token，且 `/ocg/inbox/wait` 会消费消息 | 新增**带时间戳的请求签名**：`X-OCG-Timestamp`（unix 秒，±5 分钟）+ 对 `"<ts>\n<METHOD>\n<path?query>\n" + body` 签名（`local-auth.ts` `verifySignedRequest`）。GET 路由只接受该形式；POST 路由兼容只签 body 的旧形式；`/ocg/send`、`/ocg/callback` 不变 |
| 2 | done 条目按 30 天全量常驻内存，并整体写入快照 | 新增 `mailboxMaxDone`（默认 2000，`-1` 不限）：超出时按 `doneAt` 淘汰最旧的 done 条目并写 `drop` 记录；replay 后也按当前上限淘汰 |
| 3 | `ocg chat` / `ocg test` 在 mailbox 配置下会在 CLI 进程里新建 Mailbox、compact daemon 的 JSONL，并留下一条无法回复的 `terminal` 消息 | `chat` 解析到 `mailbox` 时直接拒绝（退出 2，提示 `--agent-type http\|acp`）；`test` 固定 `OCG_AGENT_TYPE=http` |
| 4 | `wait` 在租约已分配、响应未写出时客户端断开，消息会被租住整个 `mailboxLeaseMs` | 新增 `Mailbox.release(ids, consumer)`：放回 pending、不计 redelivery；`handleInboxWait` 的 aborted 分支调用它 |
| 5 | 降级发送因 `sendAllowedChannels` 被拒时返回 `404 UNKNOWN_CHANNEL`，CLI 映射为退出 2（"参数错误"） | 降级路径把 `UNKNOWN_CHANNEL` / `UNKNOWN_ACCOUNT` / `INVALID_TARGET` 统一改写为 `410 REPLY_EXPIRED`（退出 1），响应里保留原始 `send` 结果与 hint |
| 6 | `ocg daemon start` 遇到已运行的 daemon 退出 3，而 3 在其他地方表示"daemon 不可用" | 改为退出 0，输出 `{ ok:true, alreadyRunning:true, pid, port, channels }` |
| 7 | 真实通道（qqbot / openclaw-weixin）与 POSIX 未验证 | **未处理**，仍需人工冒烟；weixin 入口在 mailbox 模式下 `markComplete()` 后再 `sendFinalReply` 依赖插件 deliver 闭包长期有效 |
