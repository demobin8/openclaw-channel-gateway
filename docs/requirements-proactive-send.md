# 需求文档：OCG 主动发送（Proactive Send）

> 状态：**已实现（OCG `1.2.0`）；v0.2 评审修订已全部落地**
>
> 日期：2026-09-21（v0.2 修订同日）
>
> 目标版本：OCG `1.2.0`（当前 `1.1.8`）
>
> 关联文档：`README.md` / `README.zh-CN.md`（通道与派发模式）、`CHANGELOG.md`
>
> 调用方：core-ai-server（`OcgSandboxService` / `OcgCallbackPool` / 待新增的 `OpenClawOutboundAdapter`）

## 0. 决策摘要

| # | 决策点 | 结论 | 理由 |
| --- | --- | --- | --- |
| D1 | 能力形态 | **HTTP 端点 + CLI 子命令**，两者共用同一实现 | HTTP 供 agent 后端（沙箱外）调用；CLI 供本机运维/联调，且天然可做验收用例 |
| D2 | 送信实现方式 | **复用插件的 `outbound` 发送原语**（`sendText` / `sendMedia`，含账号解析、媒体、平台鉴权）；**编排层（分片 / 清洗 / 回执 / 错误归一）由 OCG 借助 OpenClaw SDK 的等价 helper 补齐**。OCG 不自己实现各平台 API | 插件只提供"发送**已分片**文本"的原语；分片/清洗实际由 OpenClaw 投递管线在调用前执行（§3.7）。OCG 未注册 OpenClaw 的 plugin registry，无法直接复用 `deliverOutboundPayloads`，因此编排层必须自建（路径见 §3.7） |
| D3 | 鉴权 | `X-OCG-Signature` HMAC-SHA256（与回调同一算法），secret 取 `sendSecret`，缺省回落到 `callbackSecret`；**未配置任何 secret 时该能力默认关闭** | 沙箱内 8080 端口对集群内可达，无鉴权等于任意服务可代发消息 |
| D4 | 目标格式 | 使用**插件规范化目标**（如 `qqbot:c2c:<openid>` / `qqbot:group:<groupid>`），OCG 不自定义第二套 | 插件自带 `messaging.targetResolver`（见 §3.4），自定义格式会与插件内部解析打架 |
| D5 | 是否要求通道处于 running | **不要求**，只要求插件已加载、运行时已注入、账号凭据可解析；若插件确实依赖运行态，返回 `503 NOT_READY` 而不是静默失败 | 主动发送与收信生命周期解耦。已验证 qqbot 主动分支不依赖运行态（§3.7.3），统一错误码为 `503 NOT_READY` |
| D6 | 重试 / 排队 / 定时 | **不做**（调用方负责） | OCG 保持无状态薄网关；重试语义（窗口限制、幂等）属调用方业务 |
| D7 | 错误语义 | 平台错误**原样透传**（`message` 必带；能解析出 `code` 时一并返回，见 D11），OCG 只做稳定分层错误码；**不做隐式重试** | 主动推送常受平台窗口限制，盲目重试只会放大风控 |
| D8 | 媒体 | P0 支持 `mediaUrl` 透传（走 `outbound.sendMedia`） | 与回调回复的媒体能力对齐，实现成本低 |
| D9 | 观测 | 每次发送一行结构化日志（含结果与耗时，正文截断），不新增存储 | 与现有 log 风格一致，便于调用方对账 |
| D10 | 分片 / 格式策略 | 采用**插件声明**的 `sanitizeText` / `chunker` / `chunkerMode` / `textChunkLimit`（由 OCG 编排层执行），**不**复用回复路径的 `[i/n]` 前缀；可选 `sendChunkPrefix: true` 打开前缀（默认 `false`） | 插件声明是平台能力的事实来源；回复路径的 4000 字符 + `[i/n]` 是 OCG 自己的兼容策略，二者混用会让"回复"与"主动发送"在同一段长文本上表现不同（§3.7.2、§4 FR-4） |
| D11 | 失败判定来源 | 以插件**返回值**中的错误字段（`result.meta.error` / `result.error`）判定失败；抛异常仅作为兜底。响应中的 `platformCode` 为**可选**字段 | 实测 qqbot 发送失败不抛异常（§3.7.4）；把可选信息写成"必须回传"会导致实现层为了满足文档而去猜平台错误码 |

## 1. 背景与问题

### 1.1 现状

OCG 的定位是"**入站** IM 消息 → Agent API → 回复投递回 IM"（README 一句话：Let any OpenAI-compatible LLM provider … benefit from OpenClaw's channel ecosystem）。它目前只实现了这一条单向链路：

```
IM 用户发消息 → 插件 → OCG dispatch → agentUrl（OpenAI 兼容）
                                      ← 回复（同步 HTTP 响应 / 异步 callback）→ 插件 → IM 用户
```

### 1.2 问题

当**消息不是由 IM 用户发起**时（例如：agent 的定时任务跑完要通知用户、长任务结束后回报结果、服务端告警推送），当前 OCG 没有任何入口可以把消息投递到通道：

1. 唯一的 HTTP 面是回调服务器 `POST /ocg/callback/{token}`，而 token 是**每条入站消息**临时注册、一次性消费的（TTL 默认 30 分钟）——语义上只能"回复某条刚收到的消息"，无法发出无源头的消息；
2. CLI 没有发送类命令（现有命令见 §3.2：`start / stop / restart / status / chat / test / version / upgrade` + `channels *` / `plugins *` / `config *`）；
3. 调用方（core-ai-server）对 `channelType=openclaw` 没有 outbound 适配器，且沙箱 runtime 只代理 `/ocg/callback/` 一条路径。

结果是：**agent 绑定了 IM 通道，但只能被动答疑，不能主动通知。**

### 1.3 目标

1. 给 OCG 增加一个**主动发送**能力：外部调用方指定"通道 + 账号 + 目标 + 文本（可选媒体）"，OCG 把它投递到对应 IM；
2. 发送路径复用插件既有的 outbound **发送原语**（同一插件、同一账号解析、同一平台鉴权）；**与"回复"的一致性限定在发送原语层面**——分片 / 清洗由 OCG 编排层按插件声明执行，因此分片边界与"回复"路径可能不同（D10，差异见 §3.7.2）；
3. 提供 HTTP 与 CLI 两个入口，并有明确的鉴权、错误语义与验收标准；
4. 保持完全向后兼容：不改变现有回调/派发行为，不新增必填配置。

### 1.4 非目标

- **不做**消息队列、重试、定时/延时发送（调用方负责，见 D6）；
- **不做**广播/群发/模板渲染（调用方渲染好文本再发）；
- **不做**平台侧的"允许主动推送窗口"规避（如 QQ 的会话窗口限制只能在调用方侧处理）；
- **不做**消息持久化与已读回执；
- **不做**在 OCG 内新增通道实现（仍然只依赖 OpenClaw 插件生态）。

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 被动回复（reply） | 现有链路：对某条入站消息的回复，由 `deliver` 回调投递，token 一次性 |
| 主动发送（send） | 本文档新增：无入站消息触发，由外部调用方指定目标直接投递 |
| target | 平台侧收件目标，采用插件规范化格式（D4） |
| accountId | 通道内的账号（OCG 配置 `channels.<channelId>.accounts.<accountId>`），缺省 `default` |
| outbound adapter | OpenClaw 渠道插件暴露的发送适配器（`plugin.outbound`，§3.3） |
| 发送原语 | 插件 `outbound` 上的 `sendText` / `sendMedia`：接收**已经分片、已经清洗**的文本，负责平台鉴权与实际投递 |
| 编排层 | 发送前/后的处理：目标与账号解析、`sanitizeText`、按插件声明分片、逐片发送、结果聚合、错误归一。OpenClaw 中由投递管线实现，OCG 中必须自建（§3.7） |

## 3. 现状证据（代码定位）

> 以下为本次评审时的代码事实，实现时以最新代码为准。

### 3.1 回调服务器只有回复一条路由

`src/callback-server.ts`：

- 路由匹配 `^\/ocg\/callback\/([a-f0-9]{64})`（第 180 行），非该路径一律 404；
- token 由 `registerDeliver(deliver, ttlMs)` 生成并在 `consumeDeliver(token)` 时**取走即删**（第 50–68、212–216 行），默认 TTL 30 分钟；
- 请求体只接受 `{ reply, isError }`（第 17–23、218–232 行）。

结论：该服务器**只能投递"对某条消息的回复"**，且只能在入站消息发生后的 TTL 窗口内。

### 3.2 CLI 无发送命令

`README.md` §CLI Commands 列出的全局命令与通道管理命令中不含 send/notify 类命令；`src/cli.ts` 的启动路径为 `ocg start` → `startChannel(channelId, cfg)`。实际命令集（v0.2 校正，比 README 略多）：`start / stop / restart / status / chat / test / version / upgrade`、`channels (list|status|start|stop|restart|add|remove|login)`、`plugins (list|install)`、`config (get|set)`。

补充事实（影响 FR-2 设计）：**CLI 各命令都是进程内执行，与常驻 gateway 之间没有 IPC**——`ocg status` 只读取 `~/.openclaw-channel-gateway/ocg-state.json`（`src/process-state.ts`），`ocg channels start` 就地 `ensurePluginsLoaded()` 后启通道（`src/cli.ts:594-631`）。因此 `ocg send` 必须自行加载插件（见 FR-2）。

### 3.3 插件已具备 outbound 能力（关键前提）

OpenClaw 插件 SDK 定义了渠道发送适配器：

- 类型：`node_modules/openclaw/dist/plugin-sdk/outbound.types-BEZiz165.d.ts:203` `ChannelOutboundAdapter`
  - `deliveryMode: "direct" | "gateway" | "hybrid"`
  - 分片/清洗：`chunker` / `chunkerMode` / `textChunkLimit` / `sanitizeText`
  - 发送：`sendText`、`sendMedia`（含 `to` / `text` / `accountId` / `replyToId` / `cfg`）
  - 目标解析：`resolveTarget({ cfg, to, accountId })`（可选字段；**实测已安装插件均未实现**，实际走 `messaging` 声明，见 §3.4）
  - 回执：配合 `createMessageReceiptFromOutboundResults`（`plugin-sdk/channel-outbound`）
- 已有实现（示例：QQ Bot 插件 `node_modules/@openclaw/qqbot/dist/channel-CIb8DUm3.js:821-848`）：

```js
outbound: {
  deliveryMode: "direct",
  chunker: (text, limit) => getQQBotRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 5000,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
  sendText: async ({ to, text, accountId, replyToId, cfg }) => sendQQBotText({ cfg, to, text, accountId, replyToId }),
  sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => sendQQBotMedia({ cfg, to, text, mediaUrl, accountId, replyToId }),
}
```

- Telegram 同样具备（`node_modules/openclaw/dist/channel-qEDArY7s.js:619` + `outbound-adapter-DltSQb_u.js:90-180`，`textChunkLimit = TELEGRAM_TEXT_CHUNK_LIMIT`、`resolveEffectiveTextChunkLimit` 上限 4096、有 `sendText` / `sendMedia`）。即**首批要验收的两个通道都已具备该原语**。

结论（v0.2 修正）：**发送原语在插件层已经存在，但"分片 / 清洗 / 回执"只是插件上的声明**——真正执行它们的是 OpenClaw 的投递管线（见 §3.7）。因此缺的不只是"把能力暴露成入口"，还包括 OCG 侧的编排层。

### 3.4 目标格式由插件规定

同一插件声明了目标格式提示（`channel-CIb8DUm3.js:815` 附近）：

```js
messaging: {
  targetPrefixes: ["qqbot"],
  normalizeTarget,
  targetResolver: { looksLikeId, hint: "QQ Bot target format: qqbot:c2c:openid (direct) or qqbot:group:groupid (group)" }
}
```

结论（v0.2 修正）：目标格式由插件的 **`messaging`** 声明，而不是 `outbound.resolveTarget`：

- 实测**当前已安装的插件均未实现 `outbound.resolveTarget`**（qqbot / openclaw-weixin / dingtalk-connector / telegram 都没有）；SDK 类型里它是可选字段。
- 插件实际提供的是：`messaging.normalizeTarget`（规范化，如 qqbot 的 `normalizeTarget`、telegram 的 `normalizeTelegramMessagingTarget`）、`messaging.targetResolver.looksLikeId`（形状校验）、`messaging.targetResolver.hint`（给用户看的目标格式提示）。Telegram 另有顶层 `resolver.resolveTargets`（目录解析，面向 allowlist，不是发送目标解析）。
- SDK 侧的目标解析 helper 在 `openclaw/plugin-sdk/channel-targets`（`parseTargetPrefix` / `parseTargetPrefixes` / `buildMessagingTarget` / `normalizeTargetId` / `ensureTargetId` 等）。

因此 OCG 的 `to` 应直接接受插件的规范化格式，并按 §4 FR-3 的**降级链**解析（优先插件的自定义解析器，其次 `looksLikeId` 形状校验，最后交给平台报错）。

### 3.5 配置形态

- OCG 配置 → 插件 cfg：`buildOpenClawConfig(raw)`（`src/config.ts:126`）返回 `{ ...raw, session, liteGateway }`，即 `cfg.channels.<channelId>...` 原样可用；
- 插件账号解析基于该 cfg（如 `resolveQQBotAccount(cfg, accountId)`）；
- 现有回调相关配置键：`async` / `callbackPort`(3457) / `callbackHost`(默认 **`0.0.0.0`**，详见 `src/gateway.ts:87`、`README.md` §Async HTTP Mode、CHANGELOG 1.0.8) / `callbackSecret` / `callbackTokenTTL`(1800) / `callbackPublicHost` / `callbackPublicPort`；
- 回调服务器**无条件启动**：`startAll()` 不检查 `async`，只要启动 gateway 就会拉起（`src/gateway.ts:86-94`，`ocg channels start` 同理 `src/cli.ts:609-617`）。所以 `/ocg/send` 的可用性不依赖 `async` 开关，只依赖 FR-7 的鉴权开关。

### 3.6 调用方（core-ai）现状与依赖

- core-ai-server 侧**没有** `openclaw` 类型的 outbound 适配器（`ChannelModule` 只注册 slack/telegram/weclaw），所以即使 OCG 支持发送，调用方仍需实现适配器；
- OCG 运行在沙箱内，其回调服务器绑定 `127.0.0.1:3457`；core-ai 通过 **sandbox runtime 的反向代理**访问它，而 runtime 目前**只代理 `/ocg/callback/` 前缀**（`core-ai-sandbox-runtime/main.go:220`、`:333` → `http://127.0.0.1:3457`）；代理 handler 只接受 `POST`（其他方法 405）并要求路径前缀匹配（`main.go:323-331`）；
- runtime 自身监听 `PORT`（默认 **8080**，`main.go:181`），这就是 D3 中"沙箱 8080 端口对集群内可达"的含义；
- core-ai 侧已有地址改写先例：`OcgCallbackPool.resolveCallbackUrl` 把 `127.0.0.1/localhost/0.0.0.0:3457` 改写成 `http://<sandbox.ip>:<sandbox.port><path>`（`core-ai-server/.../channel/openclaw/OcgCallbackPool.java:88-108`），新适配器可复用该思路。

结论：本次能力落地需要**双方各改一处**（OCG 暴露端点 / runtime 放开代理前缀 + core-ai 实现适配器），且代理放开应**只针对 `/ocg/send` 精确路径**（理由见 §5.4）。OCG 侧需求见 §4，调用方约定见 §5.4。

### 3.7 编排层缺口（v0.2 评审补充，决定实现工作量）

#### 3.7.1 分片与清洗不是插件的 `sendText` 做的

`deliverOutboundPayloads` / `createChannelHandler` 的管线（`node_modules/openclaw/dist/deliver-BHfQle87.js:963-1047`）在调用插件前完成：

```
sanitizeText → chunker / chunkerMode（planOutboundTextMessageUnits，:1030-1047）
            → 逐片 sendHandler.sendText(unit.text, unit.overrides)
            → 结果聚合 / 回执（createMessageReceiptFromOutboundResults）
```

其中分片长度由 `resolveTextChunkLimit(cfg, channel, accountId, { fallbackLimit: handler.textChunkLimit })` 与可选 `resolveEffectiveTextChunkLimit`（Telegram 用它把上限压到 4096）决定，模式由 `resolveChunkMode` 决定（`outbound.types-BEZiz165.d.ts:61-81`）。

**结论：直接调用 `plugin.outbound.sendText({ text })` 会跳过清理与分片**——长文本会作为一条发给平台。OCG 必须自己补这一步。

#### 3.7.2 因此"与回复一致"不成立（需要在验收里重新定义）

| 维度 | 现有回复路径（`src/reply-chunking.ts`） | 主动发送（D10 方案，走插件声明） |
| --- | --- | --- |
| 分片上限 | `replyChunkSize`，默认 **4000**（`:5`、`:122`） | 插件 `textChunkLimit`：qqbot **5000**、telegram **4096** |
| 分片边界 | 标点/换行优先，OCG 自己的 `chooseSplitIndex`（`:150-160`） | 插件 `chunker`（qqbot 为 markdown 感知的 `chunkMarkdownText`） |
| 分片前缀 | 强制 `[i/n]\n`（`:204-216`） | 默认无（`sendChunkPrefix: true` 可打开） |
| 文本清洗 | 无（仅 qqbot 本地媒体路径改写 `:65`） | 插件 `sanitizeText`（如 `sanitizeAssistantVisibleText`） |
| 本地媒体 | `<qqimg>` 等标签路径改写进 OpenClaw media 目录 | 走 `sendMedia`，是否允许本地路径由插件校验决定 |

两者各有优劣，但**不能同时声称"与回复表现一致"**。本版选择"跟插件声明走"（D10），并把差异写入验收与文档。

#### 3.7.3 发送是否需要通道 running（回答 Q1）

qqbot 主动发送走 `!replyToId` 分支：`sendText` → `sendText$1(deliveryTarget, text, accountToCreds(account), …)`（`node_modules/@openclaw/qqbot/dist/outbound-C9wV892v.js:1225-1261`），凭据来自 cfg（`appId` / `clientSecret`），路径上只有 `loadGatewayModule()`，**看不到对 websocket 运行态的依赖**。

但它依赖两件事：

1. 插件模块已加载（`loadedPlugins.get(channel)`）；
2. 插件运行时已注入——`outbound.chunker` 里就调用了 `getQQBotRuntime()`，而 OCG 的 loader 在加载时已注入（`src/plugin-loader.ts:316-343`）。

即：**不要求 `running`，但要求"插件已加载 + runtime 已注入 + 账号可解析"**。这也解释了 FR-2 为何必须自行加载插件。

#### 3.7.4 失败以返回值表达，不一定抛异常

`sendQQBotText`（`channel-CIb8DUm3.js:690-711`）失败时返回 `{ channel, messageId: "", receipt, meta: { error } }`，内部 `sendText` 的错误形式是 `{ channel, error: formatErrorMessage(err) }`（`outbound-C9wV892v.js:1236-1261`）——**不抛异常，且错误串里没有结构化 `platformCode`**。OCG 的失败判定必须建立在返回值上（D11）；`platformCode` 只能尽力解析（例如从错误文本里提取前导数字），拿不到就置空。

#### 3.7.5 两条实现路径与代价

| 路径 | 做法 | 代价 / 风险 | 建议 |
| --- | --- | --- | --- |
| A. 手工编排（推荐） | OCG 调 `plugin.outbound.sendText/sendMedia`，自己实现 `sanitizeText` → 分片 → 逐片发送 → 聚合 | 需复刻管线语义（约 100–150 行），且要跟 SDK 的 helper 保持同步 | **本版采用**：依赖少、可测、不碰 OpenClaw 内部状态 |
| B. 复用 `deliverOutboundPayloads` | 调 `openclaw/plugin-sdk/outbound-runtime`（`deliver-xKwLODDt.d.ts:116`） | 它从 OpenClaw **全局 plugin registry** 取 adapter（`load-BBQWnOQX.js:12-23`），而 OCG 的 loader 只 `import` 模块、从不注册 registry（`src/plugin-loader.ts:218`、`:427`）→ 需要额外 bootstrap 或自建 registry 注入，耦合 OpenClaw 内部实现，升级易碎 | 暂不采用；若后续通道增多再评估 |

路径 A 需要使用的 SDK 入口（都是公开导出，不要 deep-import `dist/<hash>.js`）：

- `openclaw/plugin-sdk/text-chunking`：`chunkText` / `chunkMarkdownText` / `chunkTextWithMode` / `chunkMarkdownTextWithMode` / `chunkByNewline`
- `openclaw/plugin-sdk/channel-targets`：目标解析 helper
- `openclaw/plugin-sdk/channel-outbound`：`createMessageReceiptFromOutboundResults` 等回执工具

## 4. 功能需求

### FR-1 发送入口（HTTP）

在现有回调服务器上新增路由（与 `/ocg/callback/*` 同端口、同进程，仅限 `POST`）：

```
POST /ocg/send
```

- CORS 预检：现有服务器已对所有 `OPTIONS` 返回 `204` 并声明 `POST, OPTIONS`（`src/callback-server.ts:168-176`），本需求**无需新增**，但注意它是路径无关的；
- 若该能力未启用（§5.3），返回 **`403 DISABLED`**（定案，见 §9 Q6；理由：可排障，且"端点是否存在"本身不是秘密）；
- 服务器生命周期：回调服务器由 `startAll()` 无条件启动（§3.5），`/ocg/send` 的可用性只取决于鉴权开关；
- 请求体上限：`sendMaxBodyBytes`（默认 1 MiB，见 §5.3），超限返回 `413 PAYLOAD_TOO_LARGE`（runtime 代理侧另有 2 MiB 限制，`main.go:334`）；
- 单次发送超时：`sendTimeoutMs`（默认 30000），超时按 §FR-6 `502` + `reason: "timeout"` 返回；
- 实现落点：**业务逻辑放 `src/send-service.ts`**（纯函数：解析 → 分片 → 发送 → 结果归一，便于 §8 的单测），`src/callback-server.ts` 只增加一条薄路由 + 复用现有 HMAC 工具（`verifyHmac`，`src/callback-server.ts:92-108`）。

### FR-2 发送入口（CLI）

新增子命令：

```
ocg send --channel <channelId> --to <target> --text "..."
         [--account <accountId>] [--media-url <url>] [--reply-to <messageId>] [--json]
```

- 复用 `loadConfig()` + `buildOpenClawConfig()` 得到与 `ocg start` 完全一致的 cfg（保证账号/凭据解析一致）；
- **前置（v0.2 新增）**：必须先 `await ensurePluginsLoaded()`（CLI 是独立进程，没有 daemon 可借，见 §3.2），否则插件对象与运行时都不存在，`chunker` 之类的调用会直接失败；
- **进程模型（v0.2 新增，需写入 README）**：`ocg send` 是"自带插件栈的一次性进程"，与常驻 gateway **不共享**内存态（账号运行态、插件内部限流/计数如 QQ 的 passive-reply 计数）。因此：不带 `replyToId` 的主动发送不受影响；带 `replyToId` 的调用与常驻进程可能各记一套计数。CLI 输出需提示这一点（或在 README 中说明）；
- `--json` 输出与 HTTP 响应同构的 JSON（便于脚本化与验收）；
- 退出码：`0` 成功、`1` 发送失败（平台拒绝）、`2` 参数错误、`3` 未启用 / 鉴权失败 / `NOT_READY`（插件或账号不可用）；
- CLI 同样受 §5.3 的启用开关约束（本机运维场景也**不**放行，见 §9 Q5）。

### FR-3 目标与账号解析

1. `channel`：必须在 `cfg.channels` 中存在，否则 `404 UNKNOWN_CHANNEL`；
2. `accountId`：缺省 `default`；必须能通过插件的 config adapter 解析出账号（`resolveAccount` / `isConfigured`），否则 `400 UNKNOWN_ACCOUNT`；
3. `to`：按**降级链**解析（v0.2 修正，依据 §3.4）：
   - **①** `plugin.messaging.normalizeTarget`（若存在）→ 规范化；
   - **②** `plugin.outbound.resolveTarget` 或 `plugin.messaging.targetResolver.resolveTarget`（若存在）→ 解析并校验；
   - **③** `plugin.messaging.targetResolver.looksLikeId`（若存在）→ 形状校验；不通过则 `400 INVALID_TARGET`，并在响应里回显 `messaging.targetResolver.hint`（如 `qqbot:c2c:openid (direct) or qqbot:group:groupid (group)`）；
   - **④** 上述均不存在（当前**所有已安装插件**的情况）→ 把规范化后的 `to` 原样交给发送原语，**由平台错误决定结果**（映射为 `502` 而非 `400`），响应带 `"targetValidated": false`；
4. 通用约束：OCG **不得**自行拼接/猜测目标格式；也不得把"平台拒绝"伪装成参数错误。

### FR-4 送达路径与编排（v0.2 重写）

**A. 发送原语（插件侧，OCG 直接调用，不重复实现）**

1. 取插件对象（`getChannelPlugin(channel)`，内部即 `loadedPlugins`，`src/plugin-loader.ts:427`），必须是 OpenClaw 兼容插件且**已注入运行时**；
2. 若插件无 `outbound`（或其中的 `sendText`），返回 `501 NO_OUTBOUND_ADAPTER`；
3. 带 `mediaUrl` 时优先调用 `outbound.sendMedia({ cfg, to, text, mediaUrl, accountId, replyToId })`；`sendMedia` 不存在时降级为"文本 + 媒体链接"，响应标注 `degraded: true`；
4. 媒体取址语义（v0.2 新增）：`mediaUrl` 保证支持 http(s)；**本地路径是否可用由插件决定**（离线媒体有 allowlist 校验，见 `src/reply-chunking.ts:18-50` 对 QQ 的处理）。文档与 README 需写明：沙箱内本地文件应先落到 OpenClaw media 目录（`~/.openclaw/media/...`），否则可能被插件拒绝。

**B. 编排层（OpenClaw 由投递管线完成，OCG 必须自建；采用 §3.7.5 的路径 A）**

5. 清洗：若 `outbound.sanitizeText` 存在，先对 `text` 调用；清洗后为空 → `400 INVALID_REQUEST`；
6. 分片（D10 决策）：
   - 上限 = `resolveTextChunkLimit(cfg, channel, accountId, { fallbackLimit: outbound.textChunkLimit })`，再经可选 `outbound.resolveEffectiveTextChunkLimit` 收敛（Telegram 会压到 4096）；插件未声明上限时回落到 `replyChunkSize`（4000）；
   - 模式 = `outbound.chunkerMode ?? "length"`；
   - 优先用 `outbound.chunker(text, limit)`；不存在时用 `openclaw/plugin-sdk/text-chunking` 的 `chunkMarkdownText`（markdown）/ `chunkText`（length）；
   - `sendChunkPrefix: true`（非默认）时给每片加 `[i/n]\n` 前缀并据此重算上限（与回复路径对齐）；
7. 逐片发送：循环调用 `sendText({ cfg, to, text: chunk, accountId, replyToId })`；`replyToId` 只作用于**首片**，后续片不带（避免平台把后续片也当引用回复）；
8. 结果聚合与失败判定（D11）：逐片检查返回值——`result.meta?.error` 或 `result.error` 非空即该片失败；任一片失败即整体 `ok: false`，按 §FR-5 返回 partial 信息；
9. 超时：整体受 `sendTimeoutMs` 约束；超时只保证"OCG 不再等待"，**不代表平台未投递**，响应与日志必须标注 `reason: "timeout"` + `uncertain: true`（v0.2 新增）。语义边界：超时**只覆盖平台发送阶段**，不含插件按需加载（首次冷启动可能数秒），该差异已在 README 写明；
10. 并发：异步、不阻塞事件循环，不与 dispatch 共用阻塞路径；同一账号的**发送顺序不做保证**（由插件内部 limiter 决定），文档不承诺 FIFO。

### FR-5 结果与回执（v0.2 修正）

- 成功：返回 `ok: true`、`chunks`（**OCG 实际发起的 `sendText` 调用次数**，不是平台侧最终消息条数——插件在单次调用内仍可能拆分，尤其是文本里含媒体标签时）、`messageId`（插件/平台回执；取不到时为 `null` 或空串，二者统一按"无回执"处理）、`receipt`（若插件返回结构化回执，原样透传）、`degraded`、`targetValidated`、`elapsedMs`；
- 部分成功：`ok: false` + `partial: true` + `chunksSent` / `chunksTotal`（**不得静默吞掉部分失败**）。注意：若单次调用内部发生部分失败（插件返回值只能反映最后一次结果），OCG 无法感知，需在文档中如实说明这一限制；
- 失败：`ok: false` + `code` / `message`（见 §FR-6），若能从插件错误文本中解析出平台错误码则带 `platformCode`，否则省略（可选字段）。

### FR-6 错误语义

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 缺参数、`text` 与 `mediaUrl` 同时为空、清洗后正文为空 |
| 400 | `UNKNOWN_ACCOUNT` / `INVALID_TARGET` | 账号无法解析；目标形状校验未通过（降级链 ③） |
| 401 | `BAD_SIGNATURE` | HMAC 校验失败 |
| 403 | `DISABLED` | 能力未启用（未配置 secret 或 `sendEnabled=false`） |
| 404 | `UNKNOWN_CHANNEL` | `cfg.channels` 无该通道，或不在 `sendAllowedChannels` 白名单 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 `sendMaxBodyBytes`（v0.2 新增） |
| 501 | `NO_OUTBOUND_ADAPTER` | 插件未实现 outbound / `sendText` |
| 502 | `PLATFORM_SEND_FAILED` | 平台拒绝、网络失败或超时。带 `message`（插件错误文本，截断）；`platformCode` / `platformMessage` **为可选字段**（D11）；超时另带 `reason: "timeout"` + `uncertain: true` |
| 503 | `NOT_READY` | 插件未加载、运行时未注入、账号未就绪（术语统一为 `NOT_READY`，v0.2 修正） |

要求：**不做隐式重试**；错误信息中不得包含 secret 或完整凭据；失败判定以插件返回值为主、异常为兜底（D11 / §3.7.4）。

### FR-7 鉴权与默认关闭

1. 请求必须携带 `X-OCG-Signature: sha256=<hex>`，签名对象为**原始请求体**（与 `/ocg/callback` 的验签实现一致，见 `src/callback-server.ts:92-108`）；
2. secret 取 `sendSecret`，未配置时回落到 `callbackSecret`；
3. 两者均未配置时：HTTP 返回 `403 DISABLED`、CLI 退出码 `3`（防止沙箱内任意进程代发消息）；
4. 可选 `sendAllowedChannels: string[]` 白名单，白名单外的通道返回 `404 UNKNOWN_CHANNEL`。

### FR-8 观测与审计（v0.2 修正）

- 每次发送输出一行结构化日志，至少包含：`channel`、`accountId`、`to`（**脱敏：只保留通道与目标类型**，如 `qqbot:c2c:***` / `qqbot:group:***`；不保留尾 4 位——QQ 的 openid 较短，尾 4 位可能构成可用身份片段）、`textLength`、`media`（有/无）、`ok`、`chunks` / `chunksSent` / `chunksTotal`、`messageId`、`degraded`、`targetValidated`、`elapsedMs`、`errorCode`、`reason`（超时等）、`clientRef`；
- 正文默认不落日志；确需排查时截断 80 字符，并禁止落 secret 与完整凭据；
- `ocg status` 可选择性增加 `lastOutboundAt`（已有插件侧字段可复用，非必须）；
- 建议：`clientRef` 原样透传到日志，供调用方对账（OCG 不解析、不持久化）。

### FR-9 兼容性与回归

1. 不修改 `/ocg/callback/*` 的任何语义与配置键；
2. 不新增必填配置；未配置 `sendSecret`/`callbackSecret` 时行为与旧版本一致（即没有新端点）；
3. `ocg start` / `ocg stop` / `ocg channels *` 等既有命令行为不变；
4. `package.json` 版本号与 `CHANGELOG.md` 需同步（见 §7 A9）；**v0.2 补齐**：还需同步 `README.md` / `README.zh-CN.md`（新增 `ocg send` 与配置键、平台主动推送限制小节）与 `ocg.example.json`。

## 5. 接口契约

### 5.1 HTTP

请求：

```http
POST /ocg/send HTTP/1.1
Content-Type: application/json
X-OCG-Signature: sha256=<hmac-sha256(rawBody, secret)>

{
  "channel": "qqbot",
  "accountId": "default",
  "to": "qqbot:c2c:1A2B3C4D5E6F",
  "text": "任务已完成：报告见 https://...",
  "mediaUrl": "https://example.com/report.png",
  "replyToId": null,
  "clientRef": "core-ai:session:abc123:turn:7"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `channel` | 是 | `cfg.channels` 的键，如 `qqbot` / `telegram` |
| `accountId` | 否 | 缺省 `default` |
| `to` | 是 | 插件规范化目标（§3.4） |
| `text` | 二选一 | 文本正文 |
| `mediaUrl` | 二选一 | 媒体地址；http(s) 保证支持，本地路径是否可用由插件决定（见 FR-4 A4） |
| `replyToId` | 否 | 若插件支持引用回复；只作用于首个分片（FR-4 B7） |
| `clientRef` | 否 | 调用方关联标识，仅用于日志关联（OCG 不解析、不持久化） |

未列出的字段一律忽略（前向兼容，便于调用方先上线携带新字段）。`text` 与 `mediaUrl` 至少一个非空。

成功响应（200）：

```json
{
  "ok": true,
  "channel": "qqbot",
  "to": "qqbot:c2c:***",
  "chunks": 1,
  "messageId": "1023",
  "degraded": false,
  "targetValidated": false,
  "elapsedMs": 412
}
```

失败响应示例（502，平台拒绝）：

```json
{
  "ok": false,
  "code": "PLATFORM_SEND_FAILED",
  "message": "proactive message rejected by platform",
  "platformCode": "11253",
  "platformMessage": "主动消息超出可发送窗口",
  "partial": false,
  "elapsedMs": 233
}
```

失败响应示例（502，超时——v0.2 新增）：

```json
{
  "ok": false,
  "code": "PLATFORM_SEND_FAILED",
  "reason": "timeout",
  "uncertain": true,
  "message": "send timed out after 30000ms; platform delivery state unknown",
  "elapsedMs": 30012
}
```

说明：`platformCode` / `platformMessage` 为**可选**（D11）；`reason` / `uncertain` 仅超时场景携带。

### 5.2 CLI

```bash
ocg send --channel qqbot --to qqbot:group:123456789 --text "每日报告已生成" --json
ocg send --channel telegram --to "123456789" --text "hello" --account default
ocg send --channel qqbot --to qqbot:c2c:OPENID --media-url https://example.com/x.png --json
ocg send --channel qqbot --to qqbot:group:123456789 --text "很长日报..." --chunk-prefix   # 打开 [i/n] 前缀
```

前置与语义（v0.2 补充）：

- 执行流程：`loadConfig()` → `applyConfigEnvOverrides()` → `buildOpenClawConfig()` → **`ensurePluginsLoaded()`** → 发送；
- 独立进程，与常驻 gateway 不共享内存态（见 FR-2），因此**不要求** gateway 正在运行；反过来，`ocg send` 成功也不代表常驻进程的热状态（限流计数等）被更新；
- 未启用 / 未配置 secret 时同样拒绝（退出码 `3`），与 HTTP 一致（§9 Q5 定案）。

退出码：`0` 成功 / `1` PLATFORM_SEND_FAILED（含超时）/ `2` 参数错误（缺参数、目标形状非法）/ `3` DISABLED、鉴权失败或 NOT_READY（插件未加载、账号不可用）。

### 5.3 配置（全部可选，向后兼容）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sendEnabled` | 未配置时按"有 secret 即启用" | 显式 `false` 可彻底关闭 |
| `sendSecret` | 回落 `callbackSecret` | HMAC 共享密钥 |
| `sendAllowedChannels` | 全部 | 通道白名单；白名单外返回 `404 UNKNOWN_CHANNEL` |
| `sendMaxTextLength` | 不做限制（用插件 `textChunkLimit`） | 硬上限，超出返回 `400 INVALID_REQUEST`；仅供调用方需要硬限制时使用 |
| `sendMaxBodyBytes` | `1048576`（1 MiB） | 请求体上限，超出返回 `413 PAYLOAD_TOO_LARGE`（v0.2 新增） |
| `sendTimeoutMs` | `30000` | 单次发送超时（**只计平台发送阶段**，不含插件按需加载）；超时返回 `502` + `reason: "timeout"` + `uncertain: true`（v0.2 新增） |
| `sendChunkPrefix` | `false` | 是否为每个分片加 `[i/n]\n` 前缀（与回复路径对齐，D10；v0.2 新增） |

示例：

```json
{
  "callbackSecret": "...",
  "sendSecret": "...",
  "sendAllowedChannels": ["qqbot", "telegram"],
  "sendTimeoutMs": 30000,
  "sendChunkPrefix": false
}
```

### 5.4 与调用方（core-ai-server）的约定

**这批改动必须成对落地，否则能力不可用：**

1. **sandbox runtime 放开代理路径（最小权限）**：现在只代理 `/ocg/callback/`，且 handler 只接受 POST 与前缀匹配（`core-ai-sandbox-runtime/main.go:220`、`:323-331`）。建议**只增加 `/ocg/send` 精确路径**（而不是把前缀放宽到整个 `/ocg/`），避免未来其它端点被动暴露；同时保留 `POST` 方法限制与 2 MiB body 限制；
2. **core-ai 新增 `OpenClawOutboundAdapter`**（`type() = "openclaw"`）并在 `ChannelModule` 注册；调用地址解析复用 `OcgCallbackPool.resolveCallbackUrl` 的思路（`127.0.0.1:3457` → `http://<sandbox-ip>:<runtime-port>`，`OcgCallbackPool.java:88-108`）；
3. **重试与幂等由 core-ai 负责**：OCG 不做重试；建议失败不自动重试（平台窗口类错误重试无意义），并在 `clientRef` 中带业务标识用于对账；
4. **鉴权**：core-ai 需保存 `sendSecret`（或复用 `callbackSecret`）并对**原始 body** 做 HMAC-SHA256，格式与 `/ocg/callback` 一致。

**前置依赖（v0.2 升级为独立条目，属于端到端能否成立的关键）**

5. **「会话 ↔ 通道/账号/目标」绑定必须落库**：OCG 侧只保证 `agentUser = "${channelId}:${sessionKey}"` 随 OpenAI `user` 字段传给 agent（`src/shims/reply-dispatch-runtime.ts:56-62`，注意该前缀是条件拼接的），它**不保证**能反解出平台投递目标（各插件 sessionKey 结构不同、且未文档化）。因此 core-ai 必须在处理入站消息时持久化绑定（`会话/sessionId` → `channel` + `accountId` + 规范化的 `to`），主动发送时从绑定表取目标；**没有这张表，OCG 做得再对也发不出消息**。

**联调顺序（v0.2 新增，降低成对改动风险）**

6. 建议按以下顺序推进，每步都可独立验证：
   1. OCG 侧实现 `/ocg/send` + `ocg send`（沙箱内用 CLI 完成 §7 A1/A3/A4/A5/A6/A10 验收，全程不依赖 core-ai）；
   2. runtime 只放开 `/ocg/send`，用 `curl`（带签名）从集群内验证可达性；
   3. core-ai 侧完成绑定表落库（可先在入站链路写、灰度观察数据质量）；
   4. core-ai 接入 `OpenClawOutboundAdapter` + `sendSecret`，做端到端验收。

## 6. 非功能需求

| 类别 | 要求 |
| --- | --- |
| 兼容性 | Node.js >= 22.12（与现有一致）；不引入新的运行时依赖（仅使用 `openclaw` 已公开的 `plugin-sdk/*` 入口，不 deep-import `dist/<hash>.js`） |
| 性能 | 单次发送（不含平台耗时）额外开销 < 50ms；不与派发/回调共用阻塞路径 |
| 超时 | 整体受 `sendTimeoutMs`（默认 30000）约束；超时不代表平台未投递，必须回传 `uncertain: true`（v0.2 新增） |
| 体积 | 请求体上限 `sendMaxBodyBytes`（默认 1 MiB）；文本硬上限 `sendMaxTextLength`（可选）（v0.2 新增） |
| 并发 | `send` 与在途的 `dispatch` 互不阻塞；同一账号的发送顺序不做保证（若插件需要，由插件内部 limiter 决定）；不在模块级引入新的共享可变状态（除只读查找） |
| 安全 | 未配置 secret 默认禁用；日志不落 secret 与完整正文；`to` 按类型脱敏；错误信息不得回显凭据 |
| 可观测 | §FR-8 的结构化日志；不新增数据库/存储 |
| 兼容旧调用方 | 旧版 agent 后端（不知道 send 能力）零感知 |
| 进程模型 | HTTP 端点寄宿在 gateway 进程；CLI 为独立进程、自行加载插件；两者语义差异需在 README 写明（v0.2 新增） |

## 7. 验收标准

| # | 场景 | 期望 |
| --- | --- | --- |
| A1 | `ocg send --channel qqbot --to qqbot:c2c:<openid> --text hi --json`（已配置 secret、通道已启动或未启动均可） | 退出码 0，QQ 收到 1 条消息，JSON 含 `ok/chunks/messageId/elapsedMs` |
| A2 | 清空 `sendSecret` 与 `callbackSecret` 后调用（HTTP 与 CLI 各一次） | HTTP `403 DISABLED`、CLI 退出码 3，且**未发送** |
| A3 | 签名错误 / 缺少签名头 | HTTP `401 BAD_SIGNATURE`，且**未发送** |
| A4 | `to` 形状非法（如 `qqbot:xxx`，且插件提供 `looksLikeId`） | HTTP `400 INVALID_TARGET`，响应包含插件 hint |
| A5 | `channel=notexist`；对未实现 outbound 的插件发送；通道不在 `sendAllowedChannels` | `404 UNKNOWN_CHANNEL`；`501 NO_OUTBOUND_ADAPTER`；`404 UNKNOWN_CHANNEL` |
| A6 | 平台拒绝（如 QQ 主动消息窗口外） | HTTP `502 PLATFORM_SEND_FAILED`，`message` 为插件错误文本；`platformCode` 有则带、无则省略（**不再要求必有**） |
| A7 | 带 `media-url` 发送图片 | 走 `sendMedia` 成功；若插件不支持则 `degraded: true` 且文本含链接 |
| A8 | 回归：同步回复、异步回调（`async: true` + `X-OCG-Callback`）流程 | 行为与 `1.1.8` 完全一致 |
| A9 | 版本与变更记录 | `package.json` 递增、`CHANGELOG.md` 有条目、**README.md / README.zh-CN.md / `ocg.example.json` 同步** |
| A10 | 长文本分片（v0.2 新增） | Q：5000 字符上限的 markdown 分片；Telegram：4096 上限（`resolveEffectiveTextChunkLimit` 生效）；`chunks` 与实际调用次数一致；默认**无** `[i/n]` 前缀，`sendChunkPrefix: true` 时**有**前缀 |
| A11 | 边界（v0.2 新增） | 请求体 > `sendMaxBodyBytes` → `413 PAYLOAD_TOO_LARGE`；平台 30s 未返回 → `502` + `reason: "timeout"` + `uncertain: true` |
| A12 | CLI 进程模型（v0.2 新增） | 未启动 gateway 时 `ocg send` 仍可发送（自行加载插件）；插件加载失败 → 退出码 3 + `NOT_READY`；README 已写明与常驻进程不共享内存态 |
| A13 | 失败判定来源（v0.2 新增） | mock 插件返回 `{ meta: { error: "..." } }`（不抛异常）→ 必须映射为 `502 PLATFORM_SEND_FAILED` |

## 8. 测试计划

1. **单元测试**（建议直接测 `src/send-service.ts`）
   - 目标解析降级链：有自定义解析器 / 只有 `looksLikeId` / 都没有（④ 分支）；合法、非法、缺账号、账号未配置；
   - 鉴权：正确签名 / 错误签名 / 缺 secret；
   - 分片（D10）：无 chunker 时回落 `chunkText`；markdown 模式走 `chunkMarkdownText`；`resolveEffectiveTextChunkLimit` 生效（Telegram 4096）；`sendChunkPrefix` 开关；
   - 清洗：`sanitizeText` 被调用；清洗后为空 → `400`；
   - 错误映射（D11）：返回值 `meta.error` / `error` → `502`；抛异常 → `502`（兜底）；超时 → `502` + `reason/uncertain`；`platformCode` 解析成功/失败两种分支；
   - 降级：无 `sendMedia` 时的行为（`degraded: true` + 链接）；`replyToId` 只作用于首片；
   - 限额：`sendMaxBodyBytes` / `sendMaxTextLength` 边界。
2. **集成测试（mock 插件）**
   - 用测试插件（`outbound.sendText` / `sendMedia` 打桩）覆盖 `POST /ocg/send` 全链路，断言分片次数、分片内容、`sanitizeText` 调用、签名校验、CORS 预检、`403/404/413/501/502/503` 各错误码；
   - 复用现有 `dispatch-test.ts` 风格（`src/dispatch-test.ts`）新增 `send-test.ts`。
3. **真实通道手工验收**
   - QQ：`qqbot:group:<gid>` 与 `qqbot:c2c:<openid>` 各一次；构造"窗口外"场景验证错误透传（A6）；
   - Telegram：任意 chat id 一次（对照分片上限与 markdown 行为）；
   - 长文本（>5000 字符）各通道一次，核对分片数量与用户端体感（A10）。
4. **回归**
   - `ocg test`、`ocg start/stop/restart/status`、`ocg channels *` 全量跑一遍；确认 `process-state.json` 与既有回调流程不受影响。

## 9. 未决问题

| # | 问题 | 结论 / 建议 |
| --- | --- | --- |
| Q1 | 主动发送是否要求账号处于 running 状态 | **已定（v0.2）**：不要求 running，但要求"插件已加载 + runtime 已注入 + 账号可解析"（§3.7.3）；不满足时 `503 NOT_READY` |
| Q2 | 是否支持批量发送 / 模板 | P1：由调用方循环调用即可，OCG 不做模板 |
| Q3 | `replyToId` / `threadId` 的语义边界 | P1：仅在插件声明支持时生效，否则忽略并记 `degraded`；本版 `replyToId` 只作用于首片（FR-4 B7） |
| Q4 | 是否提供幂等键（短窗口去重） | P1：先由调用方保证；如需要，OCG 侧用内存 LRU（不落盘） |
| Q5 | CLI 是否允许在未配置 secret 时发送 | **已定（v0.2）**：不允许，与 HTTP 保持一致；文档不再保留 `--unsafe` 提议 |
| Q6 | 未启用时返回 403 还是 404 | **已定（v0.2）**：`403 DISABLED`，并在 README 写明 |
| Q7 | 平台侧主动推送限制（窗口/频次/额度）是否需要文档化 | 建议在 README 增加"平台主动推送限制"小节，汇总各通道已知限制与典型错误码 |
| Q8 | 超时后是否需要"补偿查询"（确认平台是否实际投递） | P1：本版只回 `uncertain: true`；若调用方需要，后续评估按 `messageId` 或平台 API 回查 |
| Q9 | 是否需要把 `deliverOutboundPayloads`（路径 B）作为长期方向 | 暂不做；若通道数量增长到"每个插件的编排差异难以手工维护"时再评估（§3.7.5） |

## 10. 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-09-21 | v0.1 | 初稿：确立 D1–D9、FR-1–FR-9、接口契约与验收标准 |
| 2026-09-21 | v0.2 | 评审修订：<br>① 修正 D2/§3.3/§3.7——发送原语 ≠ 编排层，明确 OCG 必须自建分片/清洗/回执（新增 §3.7，含两条实现路径对比与 SDK 入口）；<br>② D10 分片策略定案（跟插件声明，前缀可选），重写 FR-4；<br>③ D11 错误语义定案（返回值判定、`platformCode` 可选），修正 FR-5/FR-6 与 §5.1 示例；<br>④ 修正 §3.4——已安装插件均未实现 `outbound.resolveTarget`，FR-3 改为降级链；<br>⑤ 补齐 FR-2/§5.2 的 CLI 前置与进程模型（`ensurePluginsLoaded`、独立进程语义）；<br>⑥ 修正 §3.5 `callbackHost` 默认值（`0.0.0.0`）与回调服务器无条件启动的事实；<br>⑦ 新增 `sendMaxBodyBytes` / `sendTimeoutMs` / `sendChunkPrefix` 与 `413 PAYLOAD_TOO_LARGE`、超时语义；<br>⑧ 术语统一（403 DISABLED、503 NOT_READY、`to` 脱敏按类型）；<br>⑨ §5.4 升级"会话绑定表"为前置依赖，新增联调顺序；代理放开改为只针对 `/ocg/send`；<br>⑩ 验收新增 A10–A13，测试计划补齐分片/错误判定/限额用例 |
| 2026-09-21 | v0.2（实现） | 按本版实现并发布 `1.2.0`：`src/send-service.ts`（编排层）、`src/callback-server.ts` 的 `POST /ocg/send` 路由与 `SendRouteContext` 注入点、`ocg send` CLI、`src/send-test.ts`（53 项断言，mock 插件 + 真实 HTTP 路由）、`scripts/callback-regression.mjs`（回调链路回归）。实现期两处细化：<br>① 超时**只覆盖平台发送阶段**，不含插件按需加载（首次冷启动可能数秒）；<br>② `stopCallbackServer()` 显式关闭 keep-alive 连接并加 3 秒兜底，避免新端点引入的长连接客户端导致停机挂起 |

