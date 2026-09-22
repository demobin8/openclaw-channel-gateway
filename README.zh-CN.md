# OpenClaw Channel Gateway (OCG)

轻量级 IM 渠道网关 — 将 OpenClaw 的 Channel 生态桥接到任何 OpenAI 兼容的 Agent API 或 ACP stdio Agent。

> [English Documentation](README.md)

OpenClaw 拥有最丰富的 IM 渠道生态（Telegram、Discord、微信、钉钉、QQ 等），但它的 Agent 引擎是内置的。OCG 作为一层轻量网关，直接复用 OpenClaw 的 Channel 插件，将收到的消息通过 HTTP 转发给你配置的任意 OpenAI 兼容 Agent，或通过 ACP 转发给本地 stdio Agent，再把回复送回 IM 渠道。

> 一句话：让所有兼容 OpenAI API 的 LLM Provider 或支持 ACP 的编程 Agent 都能享用 OpenClaw 的 Channel 生态。

---

## 支持渠道

OCG **原生支持** OpenClaw 生态的所有 IM Channel 插件。任何带有 `"openclaw.channel"` 元数据的 npm 包都可以作为插件安装：

```bash
ocg plugins install <插件包名>
```

以下渠道已经过测试验证：

| 渠道 | 插件包 | 类型 |
|---|---|---|
| Telegram | `grammy` (bundled) | 内置 |
| Discord | bundled | 内置 |
| 微信 | `@tencent-weixin/openclaw-weixin` | 外部 |
| 钉钉 | `@dingtalk-real-ai/dingtalk-connector` | 外部 |
| QQ | `@openclaw/qqbot` | 外部 |

---

## 快速开始

### 环境要求

- **Node.js** >= 22.12

### 安装

```bash
npm install -g openclaw-channel-gateway
```

### 配置

创建 `ocg.json`（可参考 `ocg.example.json`）：

```json
{
  "agentUrl": "http://127.0.0.1:11434/v1/chat/completions",
  "model": "gpt-4o",
  "apiKey": "",
  "verbose": false,
  "channels": {
    "telegram": {
      "accounts": {
        "default": {
          "enabled": true,
          "botToken": "你的 Bot Token"
        }
      }
    }
  }
}
```

### 渠道级 Agent 传输方式

OCG 支持两种 Agent 传输方式：

- `http` — OpenAI 兼容 Chat Completions 端点。HTTP 模式可将 SSE 流式响应逐块投递到 IM 渠道。
- `acp` — 本地 ACP stdio Agent 子进程。ACP 模式会保持一个长期运行的子进程，并按 IM 会话复用 ACP session；默认会缓冲流式 delta，只向 IM 发送一条最终回复。

每个渠道可以覆盖全局 `agentType`、`agentUrl` 和 `acp` 配置。如果渠道没有配置覆盖项，则回退到全局配置。

**优先级**（从高到低）：

1. 渠道级 `channels.<id>.agentType` / `agentUrl` / `acp`
2. 全局 `agentType` / `agentUrl` / `acp`
3. 环境变量，例如 `OCG_AGENT_URL`
4. `http://127.0.0.1:11434/v1/chat/completions`（HTTP URL 兜底）

```json
{
  "agentUrl": "http://127.0.0.1:11434/v1/chat/completions",
  "channels": {
    "openclaw-weixin": {
      "accounts": { "default": { "enabled": true } }
    },
    "qqbot": {
      "enabled": true,
      "agentUrl": "http://10.0.0.5:8080/v1/chat/completions",
      "appId": "你的 App ID",
      "clientSecret": "你的 Client Secret"
    }
  }
}
```

#### ACP stdio Agent

使用 `agentType: "acp"` 可以把消息路由到支持 ACP 的本地命令，而不是 HTTP。该配置可以放在全局，也可以放在某个渠道下：

```json
{
  "agentType": "http",
  "agentUrl": "http://127.0.0.1:11434/v1/chat/completions",
  "channels": {
    "openclaw-weixin": {
      "accounts": { "default": { "enabled": true } }
    },
    "qqbot": {
      "enabled": true,
      "agentType": "acp",
      "model": "core-ai-cli",
      "acp": {
        "command": "core-ai-cli",
        "args": ["--acp-agent"],
        "cwd": "D:/core-ai"
      },
      "appId": "你的 App ID",
      "clientSecret": "你的 Client Secret"
    }
  }
}
```

| ACP 配置项 | 说明 |
|---|---|
| `command` | ACP 可执行命令，例如 `core-ai-cli`、`claude-agent-acp`、`codex-acp` 或 `codex` |
| `args` | 命令参数，例如 `["--acp-agent"]` |
| `cwd` | ACP 子进程和 session 使用的工作目录 |
| `env` | 传给子进程的额外环境变量 |
| `timeoutMs` | 请求超时时间，单位毫秒；默认 `300000` |

ACP 模式默认会缓冲流式 delta，并只向 IM 渠道发送一条最终回复。仅当你明确希望把 ACP 中间块作为 IM 消息发送时，才设置 `acpStreamBlocks: true`。

也可以通过环境变量配置：

| 环境变量 | 说明 |
|---|---|
| `OCG_AGENT_URL` | Agent API 地址 |
| `OCG_AGENT_TYPE` | Agent 传输方式：`http` 或 `acp` |
| `OCG_MODEL` | 模型名称 |
| `OCG_API_KEY` | API Key |
| `OCG_VERBOSE` | 详细日志（`1` 启用） |
| `OCG_CONFIG_PATH` | 配置文件路径 |

### 启动

```bash
ocg start
```

搞定 — OCG 会启动所有已启用的渠道，开始将消息转发给你的 Agent。

---

## CLI 命令

### 全局命令

| 命令 | 说明 |
|---|---|
| `ocg start` | 前台启动所有已启用的渠道 |
| `ocg start --background` / `ocg start -d` | 以 detached 后台进程启动所有已启用的渠道 |
| `ocg start --log-file [--log-dir <dir>]` | 将启动日志写入文件（默认：`~/.openclaw-channel-gateway/ocg.logs/`） |
| `ocg stop` | 停止所有渠道 |
| `ocg restart` | 重启所有渠道 |
| `ocg status` | 查看网关状态，包括后台启动的渠道 |
| `ocg send --channel <id> --to <目标> --text <文本>` | 主动发送消息到指定渠道目标（见[主动发送](#主动发送)） |
| `ocg test` | 运行 dispatch 冒烟测试 |
| `ocg version` | 显示版本号 |
| `ocg upgrade [--target <version>]` | 升级 OCG CLI 包 |

后台启动别名：`--background`、`--bg`、`--daemon`、`-d`。使用后台模式时，OCG 会自动写入日志文件，并打印 detached 进程 PID 和日志路径。

### Channel 管理

```bash
# 列出已配置的渠道
ocg channels list [--all] [--json]

# 渠道状态
ocg channels status [--channel <id>] [--json]

# 启动 / 停止 / 重启指定渠道
ocg channels start --channel telegram
ocg channels stop --channel telegram
ocg channels restart --channel telegram

# 添加渠道
ocg channels add --channel telegram --botToken "123:abc"
ocg channels add --channel qqbot --token "AppID:AppSecret"
ocg channels add --channel discord --token "..." --account ops

# 移除渠道
ocg channels remove --channel telegram

# QR 扫码登录（微信、钉钉等）
ocg channels login --channel openclaw-weixin
ocg channels login --channel dingtalk-connector
```

### 插件管理

```bash
# 安装外部插件
ocg plugins install @openclaw/qqbot

# 列出已安装插件
ocg plugins list
```

---

## 调度模式

### 同步 HTTP 模式（默认）

收到消息 → 转发到 Agent API → 流式接收响应 → 投递到 IM 渠道。

默认模式，满足大多数使用场景。

### ACP 模式

收到消息 → 发送 prompt 到配置的 ACP stdio 子进程 → 缓冲流式 delta → 向 IM 渠道投递一条最终回复。

ACP 模式从 IM 渠道视角看是同步请求/响应。OCG 会在多条消息之间保持 ACP 进程存活，并为同一个 IM 会话复用 ACP session。

### 异步 HTTP 模式

当 Agent 需要执行耗时任务（如爬虫、复杂推理、多步工具调用）时，同步 HTTP 连接可能超时。异步模式将请求转发与回复投递解耦 — OCG 转发消息后立即返回，Agent 完成后主动回调投递结果。

在 `ocg.json` 中启用：

```json
{
  "async": true,
  "callbackPort": 3457,
  "callbackHost": "0.0.0.0",
  "callbackSecret": "（可选共享密钥）",
  "callbackTokenTTL": 1800
}
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `async` | `false` | 启用异步调度 |
| `callbackPort` | `3457` | 回调 HTTP 服务端口 |
| `callbackHost` | `0.0.0.0` | 绑定地址 |
| `callbackSecret` | — | 可选，HMAC-SHA256 签名共享密钥 |
| `callbackTokenTTL` | `1800` | Token 有效期（秒，默认 30 分钟） |

**工作方式：**

OCG 发送标准 OpenAI 格式请求，在 `X-OCG-Callback` 头中携带回调地址。你的 Agent 处理消息（即使耗时数分钟到数小时），完成后向该回调地址 POST 回复。

**回调请求格式**（Agent → OCG）：

```json
{
  "reply": "你的回复内容",
  "isError": false
}
```

如果配置了 `callbackSecret`，需在 `X-OCG-Signature` 头中附带 HMAC-SHA256 签名：

```
X-OCG-Signature: sha256=<hex-digest>
```

每个回调 token 一次性消费，`callbackTokenTTL` 秒后过期。

---

## 主动发送

回复链路由入站消息触发。**主动发送**是反方向：由 agent 或运维指定"通道 + 账号 + 目标 + 文本（可选媒体）"，让 OCG 投递一条**没有入站消息来源**的消息（定时报告、长任务结果、告警）。

两个入口共用同一实现：

- **HTTP** —— `POST /ocg/send`（与 `/ocg/callback` 同进程、同端口）
- **CLI** —— `ocg send ...`

### 启用

能力**在配置 secret 之前默认关闭**——不能让未鉴权的调用方以网关身份发消息。

| 配置键 | 默认 | 说明 |
|---|---|---|
| `sendEnabled` | 有 secret 即启用 | 显式 `false` 可彻底关闭 |
| `sendSecret` | 回落 `callbackSecret` | `/ocg/send` 的 HMAC-SHA256 共享密钥 |
| `sendAllowedChannels` | 全部已配置通道 | 通道白名单，白名单外返回 `404 UNKNOWN_CHANNEL` |
| `sendMaxTextLength` | — | 文本硬上限（超出返回 `400 INVALID_REQUEST`） |
| `sendMaxBodyBytes` | `1048576`（1 MiB） | 请求体上限（超出返回 `413 PAYLOAD_TOO_LARGE`） |
| `sendTimeoutMs` | `30000` | 平台发送超时（超时返回 `502` + `reason: "timeout"` + `uncertain: true`） |
| `sendChunkPrefix` | `false` | 为每个分片加 `[i/n]` 前缀（与回复路径一致） |

```json
{
  "callbackSecret": "shared-secret",
  "sendSecret": "shared-secret",
  "sendAllowedChannels": ["qqbot", "telegram"]
}
```

### HTTP

```bash
BODY='{"channel":"qqbot","to":"qqbot:c2c:OPENID","text":"报告已生成"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "shared-secret" -hex | sed 's/.*= //')
curl -X POST http://127.0.0.1:3457/ocg/send \
  -H "Content-Type: application/json" \
  -H "X-OCG-Signature: sha256=$SIG" \
  -d "$BODY"
```

请求字段：`channel`（必填）、`to`（必填，插件规范化目标）、`text` / `mediaUrl`（至少一个）、`accountId`（默认 `default`）、`replyToId`、`clientRef`（仅用于日志关联）。未列出的字段忽略。

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

错误码：`400 INVALID_REQUEST` / `UNKNOWN_ACCOUNT` / `INVALID_TARGET`、`401 BAD_SIGNATURE`、`403 DISABLED`、`404 UNKNOWN_CHANNEL`、`413 PAYLOAD_TOO_LARGE`、`501 NO_OUTBOUND_ADAPTER`、`502 PLATFORM_SEND_FAILED`（平台错误原样透传，能解析出错误码时带 `platformCode`）、`503 NOT_READY`。**不做隐式重试**——重试策略由调用方负责。

### CLI

```bash
ocg send --channel qqbot --to qqbot:group:123456789 --text "每日报告已生成" --json
ocg send --channel telegram --to "123456789" --text "hello" --account default
ocg send --channel qqbot --to qqbot:c2c:OPENID --media-url https://example.com/x.png
```

退出码：`0` 成功 / `1` 平台失败（含超时）/ `2` 参数错误 / `3` 未启用、未就绪或无 outbound 适配器。

`ocg send` 是独立进程、按需加载插件，因此**不要求** gateway 正在运行；但它与网关进程**不共享内存态**（账号运行态、插件内部限流计数），需要与在线网关协同的投递请优先走 HTTP 端点。

### 投递语义

- 分片与清洗遵循**插件自身的规则**（`chunker` / `chunkerMode` / `textChunkLimit`，如 Telegram 4096、QQ 5000），与回复路径（`replyChunkSize` 4000 + `[i/n]` 前缀）不同；需要回复风格前缀时打开 `sendChunkPrefix: true`。
- `mediaUrl` 支持 http(s)；本地路径是否可用由插件决定（QQ 需放在 `~/.openclaw/media/...`）。插件无 `sendMedia` 时降级为"文本 + 链接"，响应标注 `degraded: true`。
- `replyToId` 只作用于首个分片。
- 插件为按需加载，其耗时不计入 `sendTimeoutMs`。

### 平台主动推送限制

主动消息受平台侧规则约束，OCG 无法绕过，平台错误原样返回：

| 通道 | 已知限制 | 典型错误 |
|---|---|---|
| QQ Bot | 非会话窗口内的主动消息受限 | `PLATFORM_SEND_FAILED` + 平台原始消息（如超出可发送窗口） |
| Telegram | Bot 不能主动发起会话，用户需先与 bot 对话 | `403: bot can't initiate conversation with a user` |
| 全部 | 内容风控 / 频次限制 | `message` 中的平台错误码 |

遇到这类错误请联系对应平台支持。

---

## 开发

```bash
# 开发模式（使用 tsx）
npm run dev

# 编译 TypeScript
npm run build

# 生产运行
npm start

# 主动发送冒烟测试（mock 插件 + 真实 HTTP 路由）
npx tsx src/send-test.ts
```
