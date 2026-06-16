# OpenClaw Channel Gateway (OCG)

轻量级 IM 渠道网关 — 将 OpenClaw 的 Channel 生态桥接到任何 OpenAI 兼容的 Agent API。

> [English Documentation](README.md)

OpenClaw 拥有最丰富的 IM 渠道生态（Telegram、Discord、微信、钉钉、QQ 等），但它的 Agent 引擎是内置的。OCG 作为一层轻量网关，直接复用 OpenClaw 的 Channel 插件，将收到的消息通过 HTTP 转发给你配置的任意 OpenAI 兼容 Agent（任何 LLM Provider），再把回复送回 IM 渠道。

> 一句话：让所有兼容 OpenAI API 的 LLM Provider 都能享用 OpenClaw 的 Channel 生态。

---

## 架构

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Telegram    │    │   WeChat     │    │   DingTalk   │   ...
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌──────────────────────────────────────────────────────┐
│              OpenClaw Channel Plugins                 │
│           (原生复用, 无需代码移植)                        │
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
│     任何 OpenAI 兼容 Agent API                          │
│     (OpenAI / Ollama / vLLM / LiteLLM / ...)          │
└──────────────────────────────────────────────────────┘
```

## IM 渠道

OCG 默认支持所有 OpenClaw 生态的 IM Channel 插件。任何带有 `"openclaw.channel"` 元数据的 npm 包都可以作为插件安装：

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
          "botToken": "YOUR_BOT_TOKEN_HERE"
        }
      }
    }
  }
}
```

也可以通过环境变量配置（环境变量优先级更高）：

| 环境变量 | 说明 |
|---|---|
| `OCG_AGENT_URL` | Agent API 地址 |
| `OCG_MODEL` | 模型名称 |
| `OCG_API_KEY` | API Key |
| `OCG_VERBOSE` | 详细日志 (`1` 启用) |
| `OCG_CONFIG_PATH` | 配置文件路径 |

### 启动

```bash
# 启动所有已配置的渠道
ocg start

# 或者直接使用 npm
npm run cli -- start
```

## CLI 命令

### 全局命令

| 命令 | 说明 |
|---|---|
| `ocg start` | 启动所有已启用的渠道 |
| `ocg stop` | 停止所有渠道 |
| `ocg restart` | 重启所有渠道 |
| `ocg status` | 查看网关状态 |
| `ocg test` | 运行 dispatch 冒烟测试 |
| `ocg version` | 显示版本号 |

### Channel 管理

```bash
# 列出已配置的渠道
ocg channels list [--all] [--json]

# 渠道状态
ocg channels status [--channel <id>] [--json]

# 启动/停止/重启指定渠道
ocg channels start --channel telegram
ocg channels stop --channel telegram
ocg channels restart --channel telegram

# 添加渠道
ocg channels add --channel telegram --botToken "123:abc"
ocg channels add --channel qqbot --token "AppID:AppSecret"
ocg channels add --channel discord --token "..." --account ops

# 移除渠道
ocg channels remove --channel telegram

# QR 扫码登录 (微信、钉钉等)
ocg channels login --channel openclaw-weixin
ocg channels login --channel dingtalk-connector
```

### 插件管理

```bash
# 安装外部插件
ocg plugins install @openclaw/qqbot

# 列出已安装的插件
ocg plugins list
```

## 调度模式

### 同步模式（默认）

收到消息 → HTTP POST 到 Agent API → 流式接收 SSE 响应 → 逐块投递到 IM 渠道。

```
📥 [IN]  From: telegram:12345  |  Session: telegram:default:12345
        Body: 你好
        → gpt-4o @ http://127.0.0.1:11434/v1/chat/completions
📤 [OUT] 42 chars, 4 blocks
        Text: 你好！有什么可以帮助你的吗？
```

### 异步模式（Fire & Forget）

在 `ocg.json` 中设置 `"async": true`：

```json
{
  "async": true,
  "callbackPort": 3457,
  "callbackHost": "127.0.0.1"
}
```

此模式下，OCG 将消息转发给 Agent 后立即返回，Agent 处理完毕后回调 `POST /ocg/callback` 投递回复。回调 Payload 格式：

```json
{
  "callbackToken": "<token>",
  "reply": "回复内容",
  "isError": false
}
```

## 兼容性原理

OCG 通过三层拦截实现与 OpenClaw Channel 插件的完全兼容：

1. **源码级拦截（ESM Loader Hook）**
   当插件代码导入 `openclaw/plugin-sdk/*` 时，自动重定向到 OCG 的 shim 模块。Shim 保留所有真实的工具函数（路由、命令检测、会话等），只替换 dispatch 函数为 HTTP 转发。

2. **Chunk 级拦截**
   对于已编译的 OpenClaw chunk，loader hook 直接替换源码，以 OCG 的 HTTP dispatch 实现替代内置 Agent 引擎。

3. **插件运行时**
   OCG 构造了一个完整的 `PluginRuntime` 对象（in-memory store、logger、reply pipeline、session、routing、commands 等），Channel 插件完全感知不到自己运行在网关模式下。

## 开发

```bash
# 开发模式 (使用 tsx)
npm run dev

# 编译 TypeScript
npm run build

# 生产运行
npm start
```

### 项目结构

```
openclaw-channel-gateway/
├── bin/
│   └── ocg.cjs                  # CLI 入口 (CJS bootstrap)
├── src/
│   ├── index.ts                 # 主模块入口
│   ├── cli.ts                   # CLI 命令解析与处理
│   ├── config.ts                # 配置加载/写入 (ocg.json)
│   ├── gateway.ts               # 渠道生命周期管理
│   ├── plugin-loader.ts         # 插件发现与加载
│   ├── loader.ts                # ESM Loader Hook
│   ├── callback-server.ts       # 异步回调 HTTP 服务器
│   ├── auth/
│   │   └── dingtalk-login.ts    # 钉钉设备授权流程
│   └── shims/
│       ├── reply-dispatch-runtime.ts  # HTTP dispatch 替换
│       ├── runtime.ts                 # PluginRuntime 工厂
│       ├── runtime-env.ts
│       ├── runtime-config-snapshot.ts
│       └── session-store-runtime.ts
├── dist/                        # 编译产物
├── ocg.example.json             # 配置示例
├── tsconfig.json
└── package.json
```

