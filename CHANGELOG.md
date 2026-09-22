# Changelog

All notable changes to OpenClaw Channel Gateway will be documented in this file.

---

## [1.2.0] — 2026-09-21

### Added

- **Proactive send**: deliver messages that are not driven by an inbound IM message.
  - HTTP: `POST /ocg/send` on the callback server, HMAC-SHA256 signed with
    `sendSecret` (falls back to `callbackSecret`) via `X-OCG-Signature`.
  - CLI: `ocg send --channel <id> --to <target> (--text <text> | --media-url <url>)`
    with `--account`, `--reply-to`, `--chunk-prefix`, `--json`.
  - Targets use the channel plugin's own normalized format (e.g.
    `qqbot:c2c:<openid>`, `qqbot:group:<groupid>`); the account is resolved
    through the plugin's config adapter.
  - Delivery reuses the plugin's send primitives (`outbound.sendText` /
    `sendMedia`) and layers the orchestration OCG previously did not have:
    `sanitizeText` cleanup, chunking by the plugin's declared
    `chunker` / `chunkerMode` / `textChunkLimit` (SDK helpers as fallback),
    per-chunk sends, result aggregation and error normalization.
  - New optional config keys: `sendEnabled`, `sendSecret`, `sendAllowedChannels`,
    `sendMaxTextLength`, `sendMaxBodyBytes` (1 MiB), `sendTimeoutMs` (30 s),
    `sendChunkPrefix`. The capability stays **disabled** until a secret is set.
  - Errors surface as `400/401/403/404/413/501/502/503` with the platform message
    passed through (`platformCode` when parseable); no implicit retries.
- `src/send-service.ts` (orchestration + validation) and `src/send-test.ts`
  (mock-plugin + real-HTTP-route smoke test: `npx tsx src/send-test.ts`).
- Startup log line reporting whether proactive send is enabled and for which
  channels.

### Changed

- `startCallbackServer()` accepts an optional injection seam for the send route
  (used by tests); existing callers are unaffected.
- `ChannelPluginObject` type now models `outbound` and `messaging`; the loader
  exposes `ensureChannelPluginLoaded()` for on-demand, single-channel loading.
- README / README.zh-CN document proactive send, its config keys, exit codes and
  known platform push limits.

---

## [1.0.8] — 2026-06-25

### Changed

- **callbackHost default**: changed from `127.0.0.1` to `0.0.0.0` (listen on all interfaces) for Docker/LAN friendliness.
- `buildCallbackUrl` automatically rewrites `0.0.0.0` to `127.0.0.1` in the `X-OCG-Callback` header URL so the Agent can always reach the callback server.

### Added

- `ocg.example.json` now includes commented-out async configuration hints.

---

## [1.0.7] — 2026-06-25

### Changed

- **Callback token TTL**: default increased from 10 minutes to **30 minutes**.
- TTL is now configurable via `callbackTokenTTL` in `ocg.json` (seconds).

### Added

- `callbackTokenTTL` config field.  
- `registerDeliver` now accepts an optional `ttlMs` parameter.

---

## [1.0.6] — 2026-06-25

### Documentation

- Comprehensive async callback protocol documentation in both English (`README.md`) and Chinese (`README.zh-CN.md`):
  - Architecture diagram (how async mode decouples forwarding and delivery)
  - Full protocol spec: forward request (`X-OCG-Callback` header), callback request (`POST /ocg/callback/{token}`)
  - HMAC-SHA256 signature specification
  - Configuration reference table
  - Token lifecycle (TTL, single-use, randomBytes)
  - Minimal Node.js Agent Runtime example code

---

## [1.0.5] — 2026-06-25

### Added

- **Standardized async callback protocol** — the core protocol refactor:

  | Before | After |
  |---|---|
  | `callback_url` and `callback_token` embedded in request body (non-standard OpenAI) | `X-OCG-Callback` HTTP header (clean OpenAI body) |
  | `POST /ocg/callback` + body `{ callbackToken, reply }` | `POST /ocg/callback/{token}` (REST webhook) |
  | No auth on callback endpoint | Optional HMAC-SHA256 signature (`callbackSecret`) |
  | `Math.random()` token | `crypto.randomBytes(32)` token |

- **All 5 channels** (Telegram, Discord, WeChat, DingTalk, QQ) now support async mode (previously only Telegram/Discord).
- `callbackSecret` config field for HMAC callback verification.
- Backward-compatible error hint for old Agent runtimes using the deprecated `POST /ocg/callback` endpoint.

### Changed

- `DeliverFn` type centralized in `callback-server.ts` (imported by runtime shims).
- `startCallbackServer` now accepts optional `secret` parameter.

---

## [1.0.4] — 2026-06-25

### Changed

- **Configuration directory**: moved from `./ocg.json` (CWD) to `~/.openclaw-channel-gateway/ocg.json`.
- Session data (`ocg-sessions.json`) moved to the same directory.
- Environment variable `OCG_CONFIG_PATH` still takes highest priority.

### Fixed

- Plugin loader package name match: `"ocg"` → `"openclaw-channel-gateway"`.

---

## [1.0.3] — 2026-06-25

### Fixed

- **CLI binary not installed**: `.gitignore` recursively excluded `bin/`, so `bin/ocg.cjs` was missing from the npm package and `ocg` command was unavailable after `npm install -g`.
- Added `!/bin/` exception rule to `.gitignore`.
- `bin/ocg.cjs` is now tracked in version control.

---

## [1.0.2] and earlier

Initial release with:

- ESM Loader Hook-based channel plugin compatibility
- Synchronous SSE streaming dispatch
- Basic async fire-and-forget dispatch with in-memory token registry
- CLI: `ocg start/stop/restart/status/test`, channel management, plugin installation, QR login
- 5 supported channels: Telegram, Discord, WeChat, DingTalk, QQ
- DingTalk built-in device authorization flow
