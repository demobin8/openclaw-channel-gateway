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

## IM Channels

OCG supports all OpenClaw ecosystem IM channel plugins by default. Any npm package with `"openclaw.channel"` metadata can be installed as a plugin:

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
### Per-Channel agentUrl

Each channel can override the global `agentUrl` with its own endpoint. If a channel does not specify `agentUrl`, it falls back to the global `agentUrl`.

**Priority** (highest to lowest):

1. Channel-level `channels.<id>.agentUrl`
2. Global `agentUrl`
3. `OCG_AGENT_URL` env variable
4. `http://127.0.0.1:11434/v1/chat/completions` (fallback)

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

In this example, `openclaw-weixin` uses the global endpoint while `qqbot` routes to its own `agentUrl`. Run `ocg status` to see each channel's effective agent URL in the output.

You can also configure via environment variables (env vars take precedence over global config, but per-channel `agentUrl` has the highest priority):

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

When the Agent Runtime needs to run long tasks (e.g., crawling, complex reasoning, multi-step tool calls), the synchronous HTTP connection may time out. Async mode solves this by decoupling request forwarding and reply delivery.

**How it works:**

```
IM → OCG ──POST (fast)──→ Agent Runtime
                              │
                              ├─ 1. Parse incoming message
                              ├─ 2. Run long task (minutes~hours)
                              └─ 3. POST /ocg/callback/{token} → OCG → IM
```

OCG forwards the message (clean OpenAI format) and returns immediately. No HTTP connection is held open. When the Agent finishes, it calls the callback URL to deliver the reply.

**Configuration** (`ocg.json`):

```json
{
  "async": true,
  "callbackPort": 3457,
  "callbackHost": "0.0.0.0",
  "callbackSecret": "(optional)",
  "callbackTokenTTL": 1800
}
```

| Config key | Default | Description |
|---|---|---|
| `async` | `false` | Enable async dispatch mode |
| `callbackPort` | `3457` | Port for the built-in callback HTTP server |
| `callbackHost` | `0.0.0.0` | Bind address (all interfaces). The `X-OCG-Callback` URL auto-rewrites `0.0.0.0` → `127.0.0.1` |
| `callbackSecret` | — | Shared secret for HMAC-SHA256 signature verification |
| `callbackTokenTTL` | `1800` | Callback token lifetime in seconds (default 30 minutes) |

**Protocol — Forward request** (OCG → Agent):

OCG sends a **standard OpenAI chat completion request** with the callback URL in an HTTP header. The request body contains no custom fields — any OpenAI-compatible API can receive it unchanged.

```http
POST /v1/chat/completions
Content-Type: application/json
X-OCG-Callback: http://127.0.0.1:3457/ocg/callback/a1b2c3d4...
Authorization: Bearer sk-xxx

{
  "model": "gpt-4o",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false
}
```

| Header | Description |
|---|---|
| `X-OCG-Callback` | Callback URL the Agent must POST to when done. Includes a 64-hex-char random token in the path. |

**Protocol — Callback request** (Agent → OCG):

When the Agent finishes processing, it sends the reply to the callback URL from the `X-OCG-Callback` header.

```http
POST /ocg/callback/a1b2c3d4...
Content-Type: application/json
X-OCG-Signature: sha256=<hex-digest>

{
  "reply": "Reply content",
  "isError": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `reply` | string \| object | Yes | Reply text (`string`) or structured content (`{ text, content, ... }`) |
| `isError` | boolean | No | If `true`, OCG delivers as an error message (default `false`) |

**HMAC Signature** (optional):

When `callbackSecret` is configured, the Agent must sign each callback request:

```
signature = HMAC-SHA256(request-body-bytes, callbackSecret)
header    = "sha256=" + hex(signature)
```

OCG rejects callbacks with missing or incorrect signatures (HTTP 401).

**Token lifecycle:**

- Each forwarded message gets a unique 64-hex-char token (backed by `crypto.randomBytes`).
- The token is valid for **30 minutes** by default (configurable via `callbackTokenTTL` in seconds). If the Agent takes longer, it must re-send (the original message will still be delivered to the Agent, and the callback will get a new token).
- Each token is **single-use** — consumed on first successful callback.

**Example Agent Runtime (Node.js)**:

```js
import http from "node:http";

const server = http.createServer(async (req, res) => {
  // 1. Read the forward request
  const body = await readBody(req);
  const callbackUrl = req.headers["x-ocg-callback"];
  if (!callbackUrl) {
    res.writeHead(400); res.end("missing X-OCG-Callback"); return;
  }

  // 2. Respond immediately — OCG doesn't wait
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "accepted" }));

  // 3. Do the actual work
  const msg = JSON.parse(body).messages[0].content;
  const reply = await yourAgent.process(msg); // may take minutes

  // 4. Call back OCG with the result
  await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply }),
  });
});
server.listen(8080);
```

> **Tip**: The above example shows a minimal Agent Runtime. For HMAC signing, compute `HMAC-SHA256(responseBody, secret)` and add the `X-OCG-Signature` header.

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

