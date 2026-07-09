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

## 开发

```bash
# 开发模式（使用 tsx）
npm run dev

# 编译 TypeScript
npm run build

# 生产运行
npm start
```
