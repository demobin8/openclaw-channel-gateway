# OpenClaw Channel Gateway (OCG)

A lightweight IM channel gateway that bridges OpenClaw's channel ecosystem to any OpenAI-compatible Agent API.

> [中文文档](README.zh-CN.md)

OpenClaw has the richest IM channel ecosystem (Telegram, Discord, WeChat, DingTalk, QQ, and more), but its agent engine is built-in. OCG acts as a thin gateway layer — it reuses OpenClaw's channel plugins directly, forwards incoming messages via HTTP to any OpenAI-compatible Agent you configure (any LLM provider), and delivers the reply back to the IM channel.

> In one sentence: Let any OpenAI-compatible LLM provider benefit from OpenClaw's channel ecosystem.

---

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Telegram    │    │   WeChat     │    │   DingTalk   │   ...
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌──────────────────────────────────────────────────────┐
│              OpenClaw Channel Plugins                 │
│    (reused natively — no code porting needed)         │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│                    OCG Gateway                        │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ ESM Loader  │  │  Dispatch    │  │  Callback   │  │
│  │   Hook      │  │  Shims       │  │  Server     │  │
│  └─────────────┘  └──────────────┘  └─────────────┘  │
└──────────────────────┬───────────────────────────────┘
                       │  HTTP (SSE streaming)
                       ▼
┌──────────────────────────────────────────────────────┐
│     Any OpenAI-compatible Agent API                   │
│     (OpenAI / Ollama / vLLM / LiteLLM / ...)          │
└──────────────────────────────────────────────────────┘
```

## Supported IM Channels

All OpenClaw bundled and external channel plugins work out of the box:

| Channel | Plugin Package | Type |
|---|---|---|
| Telegram | `grammy` (bundled) | Built-in |
| Discord | bundled | Built-in |
| WeChat | `@tencent-weixin/openclaw-weixin` | External |
| DingTalk | `@dingtalk-real-ai/dingtalk-connector` | External |
| QQ | `@openclaw/qqbot` | External |

> Any npm package with `"openclaw.channel"` metadata can be installed as a plugin.

## Quick Start

### Prerequisites

- **Node.js** >= 22.12
- **npm** >= 9

### Installation

```bash
git clone https://github.com/openclaw/openclaw-channel-gateway.git
cd openclaw-channel-gateway
npm install
npm run build
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

You can also configure via environment variables (env vars take precedence):

| Env Variable | Description |
|---|---|
| `OCG_AGENT_URL` | Agent API endpoint |
| `OCG_MODEL` | Model name |
| `OCG_API_KEY` | API key |
| `OCG_VERBOSE` | Verbose logging (`1` to enable) |
| `OCG_CONFIG_PATH` | Config file path |

### Launch

```bash
# Start all configured channels
ocg start

# Or use npm directly
npm run cli -- start
```

## CLI Commands

### Global Commands

| Command | Description |
|---|---|
| `ocg start` | Start all enabled channels |
| `ocg stop` | Stop all channels |
| `ocg restart` | Restart all channels |
| `ocg status` | Show gateway status |
| `ocg test` | Run dispatch smoke test |
| `ocg version` | Print version |

### Channel Management

```bash
# List configured channels
ocg channels list [--all] [--json]

# Channel status
ocg channels status [--channel <id>] [--json]

# Start / stop / restart a channel
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

## Dispatch Modes

### Synchronous Mode (default)

Receive message → HTTP POST to Agent API → stream SSE response → deliver blocks to IM channel.

```
📥 [IN]  From: telegram:12345  |  Session: telegram:default:12345
        Body: Hello
        → gpt-4o @ http://127.0.0.1:11434/v1/chat/completions
📤 [OUT] 42 chars, 4 blocks
        Text: Hello! How can I help you?
```

### Async Mode (Fire & Forget)

Set `"async": true` in `ocg.json`:

```json
{
  "async": true,
  "callbackPort": 3457,
  "callbackHost": "127.0.0.1"
}
```

In this mode, OCG forwards the message to the Agent and returns immediately. The Agent calls back `POST /ocg/callback` when the reply is ready. Callback payload format:

```json
{
  "callbackToken": "<token>",
  "reply": "Reply content",
  "isError": false
}
```

## How It Stays Compatible with OpenClaw

OCG achieves full compatibility with OpenClaw channel plugins through three interception layers:

1. **Source-level interception (ESM Loader Hook)**
   When plugin code imports `openclaw/plugin-sdk/*`, it is automatically redirected to OCG's shim modules. The shims preserve all real utility functions (routing, command detection, sessions, etc.) and only replace the dispatch function with HTTP forwarding.

2. **Chunk-level interception**
   For pre-compiled OpenClaw chunks, the loader hook replaces the source entirely with OCG's HTTP dispatch implementation, so the built-in agent engine is never invoked.

3. **Plugin Runtime**
   OCG constructs a full `PluginRuntime` object (in-memory store, logger, reply pipeline, session, routing, commands, etc.). Channel plugins are completely unaware they're running in gateway mode.

## Development

```bash
# Dev mode (with tsx)
npm run dev

# Build TypeScript
npm run build

# Production run
npm start
```

### Project Structure

```
openclaw-channel-gateway/
├── bin/
│   └── ocg.cjs                  # CLI entry point (CJS bootstrap)
├── src/
│   ├── index.ts                 # Main module entry
│   ├── cli.ts                   # CLI command parsing & handling
│   ├── config.ts                # Config load/write (ocg.json)
│   ├── gateway.ts               # Channel lifecycle management
│   ├── plugin-loader.ts         # Plugin discovery & loading
│   ├── loader.ts                # ESM Loader Hook
│   ├── callback-server.ts       # Async callback HTTP server
│   ├── auth/
│   │   └── dingtalk-login.ts    # DingTalk device auth flow
│   └── shims/
│       ├── reply-dispatch-runtime.ts  # HTTP dispatch replacement
│       ├── runtime.ts                 # PluginRuntime factory
│       ├── runtime-env.ts
│       ├── runtime-config-snapshot.ts
│       └── session-store-runtime.ts
├── dist/                        # Build output
├── ocg.example.json             # Config example
├── tsconfig.json
└── package.json
```

## License

MIT
