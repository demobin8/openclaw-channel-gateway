# OpenClaw Channel Gateway (OCG)

A lightweight IM channel gateway that bridges OpenClaw's channel ecosystem to any OpenAI-compatible Agent API or ACP stdio agent.

> [中文文档](README.zh-CN.md)

OpenClaw has the richest IM channel ecosystem (Telegram, Discord, WeChat, DingTalk, QQ, and more), but its agent engine is built-in. OCG acts as a thin gateway layer — it reuses OpenClaw's channel plugins directly, forwards incoming messages via HTTP to any OpenAI-compatible Agent you configure or via ACP to a local stdio agent, and delivers the reply back to the IM channel.

> In one sentence: Let any OpenAI-compatible LLM provider or ACP-capable coding agent benefit from OpenClaw's channel ecosystem.

---

## Supported Channels

OCG supports **all** OpenClaw ecosystem IM channel plugins out of the box. Any npm package with `"openclaw.channel"` metadata works as a plugin:

```bash
ocg plugins install <plugin-package>
```

The following channels have been tested and verified:

| Channel | Plugin Package | Type |
|---|---|---|
| Telegram | `grammy` (bundled) | Built-in |
| Discord | bundled | Built-in |
| WeChat | `@tencent-weixin/openclaw-weixin` | External |
| DingTalk | `@dingtalk-real-ai/dingtalk-connector` | External |
| QQ | `@openclaw/qqbot` | External |

---

## Quick Start

### Prerequisites

- **Node.js** >= 22.12

### Installation

```bash
npm install -g openclaw-channel-gateway
```

### Configuration

Create `ocg.json` (see `ocg.example.json` for reference):

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
          "botToken": "YOUR_BOT_TOKEN_HERE"
        }
      }
    }
  }
}
```

### Per-Channel Agent Transport

OCG supports two agent transports:

- `http` — OpenAI-compatible Chat Completions endpoint. HTTP mode can stream SSE blocks to IM channels.
- `acp` — local ACP stdio agent subprocess. ACP mode keeps a long-running process and reuses sessions by IM conversation; by default it buffers streaming deltas and sends one final IM message.

Each channel can override the global `agentType`, `agentUrl`, and `acp` settings. If a channel does not specify an override, it falls back to the global settings.

**Priority** (highest to lowest):

1. Channel-level `channels.<id>.agentType` / `agentUrl` / `acp`
2. Global `agentType` / `agentUrl` / `acp`
3. Environment variables such as `OCG_AGENT_URL`
4. `http://127.0.0.1:11434/v1/chat/completions` (fallback HTTP URL)

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
      "appId": "YOUR_APP_ID",
      "clientSecret": "YOUR_CLIENT_SECRET"
    }
  }
}
```

#### ACP stdio agent

Use `agentType: "acp"` to route messages to an ACP-capable local command instead of HTTP. This can be set globally or per channel:

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
      "appId": "YOUR_APP_ID",
      "clientSecret": "YOUR_CLIENT_SECRET"
    }
  }
}
```

| ACP key | Description |
|---|---|
| `command` | ACP executable, e.g. `core-ai-cli`, `claude-agent-acp`, `codex-acp`, or `codex` |
| `args` | Command arguments, e.g. `["--acp-agent"]` |
| `cwd` | Working directory for the ACP subprocess and sessions |
| `env` | Extra environment variables for the subprocess |
| `timeoutMs` | Request timeout in milliseconds; default `300000` |

By default ACP streaming deltas are buffered and OCG sends a single final reply to the IM channel. Set `acpStreamBlocks: true` only if you want intermediate ACP chunks delivered as IM messages.

You can also configure via environment variables:

| Env Variable | Description |
|---|---|
| `OCG_AGENT_URL` | Agent API endpoint |
| `OCG_AGENT_TYPE` | Agent transport: `http` or `acp` |
| `OCG_MODEL` | Model name |
| `OCG_API_KEY` | API key |
| `OCG_VERBOSE` | Verbose logging (`1` to enable) |
| `OCG_CONFIG_PATH` | Config file path |

### Launch

```bash
ocg start
```

That's it — OCG will start all enabled channels and begin forwarding messages to your agent.

---

## CLI Commands

### Global Commands

| Command | Description |
|---|---|
| `ocg start` | Start all enabled channels in the foreground |
| `ocg start --background` / `ocg start -d` | Start all enabled channels as a detached background process |
| `ocg start --log-file [--log-dir <dir>]` | Write start logs to a file (default: `~/.openclaw-channel-gateway/ocg.logs/`) |
| `ocg stop` | Stop all channels |
| `ocg restart` | Restart all channels |
| `ocg status` | Show gateway status, including background-started channels |
| `ocg test` | Run dispatch smoke test |
| `ocg version` | Print version |
| `ocg upgrade [--target <version>]` | Upgrade the OCG CLI package |

Background start aliases: `--background`, `--bg`, `--daemon`, and `-d`. In background mode, OCG automatically writes logs and prints the detached PID plus the log path.

### Channel Management

```bash
# List configured channels
ocg channels list [--all] [--json]

# Channel status
ocg channels status [--channel <id>] [--json]

# Start / stop / restart a specific channel
ocg channels start --channel telegram
ocg channels stop --channel telegram
ocg channels restart --channel telegram

# Add a channel
ocg channels add --channel telegram --botToken "123:abc"
ocg channels add --channel qqbot --token "AppID:AppSecret"
ocg channels add --channel discord --token "..." --account ops

# Remove a channel
ocg channels remove --channel telegram

# QR code login (WeChat, DingTalk, etc.)
ocg channels login --channel openclaw-weixin
ocg channels login --channel dingtalk-connector
```

### Plugin Management

```bash
# Install an external plugin
ocg plugins install @openclaw/qqbot

# List installed plugins
ocg plugins list
```

---

## Dispatch Modes

### Synchronous HTTP Mode (default)

Receive message → Forward to Agent API → Stream response back → Deliver to IM channel.

This is the default mode and works well for most use cases.

### ACP Mode

Receive message → send prompt to the configured ACP stdio subprocess → buffer streaming deltas → deliver one final reply to IM channel.

ACP mode uses synchronous request/response semantics from the IM perspective. OCG keeps the ACP process alive across messages and reuses the ACP session for the same IM conversation.

### Async HTTP Mode

When your agent needs to run long tasks (crawling, complex reasoning, multi-step tool calls), the synchronous HTTP connection may time out. Async mode decouples request forwarding from reply delivery — OCG forwards the message and returns immediately, then your agent calls back when done.

Enable async mode in `ocg.json`:

```json
{
  "async": true,
  "callbackPort": 3457,
  "callbackHost": "0.0.0.0",
  "callbackSecret": "(optional shared secret)",
  "callbackTokenTTL": 1800
}
```

| Config key | Default | Description |
|---|---|---|
| `async` | `false` | Enable async dispatch |
| `callbackPort` | `3457` | Callback HTTP server port |
| `callbackHost` | `0.0.0.0` | Bind address |
| `callbackSecret` | — | Optional HMAC-SHA256 shared secret for signing callbacks |
| `callbackTokenTTL` | `1800` | Token lifetime in seconds (default 30 min) |

**How it works:**

OCG sends a standard OpenAI chat completion request with a callback URL in the `X-OCG-Callback` header. Your agent processes the message (even for minutes or hours), then POSTs the reply to that callback URL.

**Callback request format** (Agent → OCG):

```json
{
  "reply": "Your reply text here",
  "isError": false
}
```

If `callbackSecret` is configured, include an HMAC-SHA256 signature in the `X-OCG-Signature` header:

```
X-OCG-Signature: sha256=<hex-digest>
```

Each callback token is single-use and expires after `callbackTokenTTL` seconds.

---

## Development

```bash
# Dev mode (with tsx)
npm run dev

# Build TypeScript
npm run build

# Production run
npm start
```
