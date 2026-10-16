# Changelog

All notable changes to OpenClaw Channel Gateway will be documented in this file.

---

## [1.3.0] — 2026-10-16

### Added

- **Mailbox transport** (`agentType: "mailbox"`): inbound messages are queued in
  the daemon and pulled by short-lived CLI commands, so a coding agent in a
  terminal can wait for, process and answer IM messages like a mail client.
  - `ocg inbox wait` — long-poll (≤120 s) with consumer names and leases;
    timeouts return an empty list with exit 0.
  - `ocg reply <id>` — replies through the plugin's passive-reply handle when
    still valid, otherwise degrades to a proactive send to the same peer
    (`via` field in the response). `--text`, `--text-file` or `-` (stdin);
    `--media`, `--error`.
  - `ocg inbox list / show / ack`, `ocg targets list`.
  - Durable queue: append-only JSONL (`<configDir>/mailbox/mailbox.jsonl`) with
    restart replay (replayed messages are `replyable: false`), lease expiry
    with redelivery counting, queue cap, media download from URLs, retention
    for media + history.
- **Agent routes** on the callback server: `GET /ocg/health`,
  `GET /ocg/inbox(/wait|/{id})`, `POST /ocg/inbox/{id}/ack|reply`,
  `GET /ocg/targets`. Auth via the new **local token**
  (`<configDir>/ocg-local-token`, loopback-only under a wildcard bind) or the
  existing HMAC signature; uniform `{ok:false, code, message, hint}` errors.
- **Daemon control**: `ocg daemon start` (background + health polling),
  `ocg daemon stop`, `ocg daemon status`, `ocg daemon logs [--tail --follow]`,
  `ocg doctor`, `ocg skill install/show` (SKILL.md ships in the npm package
  under `skills/ocg/`).
- **Single-instance guard**: `ocg start` refuses to boot when a live daemon
  already answers `/ocg/health`.
- Graceful daemon shutdown: `SIGINT`/`SIGTERM` stop channels, flush state and
  exit; `ocg-state.json` now records the bound `callbackPort` / `callbackHost`.

### Changed

- **`ocg stop` actually stops background daemons** — it previously only stopped
  in-process channels (a no-op in background mode) and left the state file
  behind. It now reads the state file and terminates the process
  (`taskkill /T /F` on Windows, SIGTERM → SIGKILL on POSIX).
- **`ocg send` prefers the running daemon** (`POST /ocg/send` with the local
  token, no plugin reload, shared account state) and falls back to the
  in-process implementation when the daemon is absent; the result carries
  `inProcess` (true/false).
- **`ocg status` merges `/ocg/health`** (daemon version/pid, mailbox backlog,
  per-account channel state) when reachable.
- **Shared inbound dispatch**: `dispatchReplyWithBufferedBlockDispatcher`
  (telegram/discord/qqbot…) and `dispatchReplyFromConfig`
  (openclaw-weixin…) now call one `dispatchInbound()` implementation
  (`src/inbound.ts`) that selects mailbox / ACP / HTTP. Both entries keep their
  previous delivery semantics exactly (final-after-blocks policy, empty-body
  handling, `disableBlockStreaming`).
- **State file, local token, mailbox data and logs live next to the config**
  (`dirname(OCG_CONFIG_PATH)`), so a custom config path isolates a full
  instance instead of only the JSON file.
- `ocg daemon start` readiness window: accepts a healthy daemon once a channel
  reports running, or 30 s after health first answers; gives up at `--timeout`
  (default 120 s). A pure 30 s window mis-reported timeouts on machines where
  cold plugin loading alone takes ~1 minute.

### Fixed

- `ocg stop` / `ocg restart` no longer leave the background process running
  (see Changed).
- `acp-dispatch-test.ts` passed `acpStreamBlocks` nowhere while asserting block
  delivery — the test failed on the previous revision too; the fixture now
  enables the flag it asserts on.

### Tests

- `src/mailbox-test.ts` (queue, leases, redelivery cap, JSONL replay, media
  download, targets, dispatchInbound integration).
- `src/agent-routes-test.ts` (auth incl. loopback rule, long-poll wake-up,
  reply via handle vs degrade, `ALREADY_REPLIED`, `LEASE_HELD_BY_OTHER`,
  `MAILBOX_DISABLED`).
- `scripts/e2e-mailbox.ts` (`npm run test:e2e`): real CLI processes against a
  live daemon — wait → reply → list → ack → targets → status → doctor.
- Regression suites (`send-test`, `dispatch-test`, `acp-dispatch-test`,
  `loader-test`) stay green; `npm test` runs them all.

---

## [1.2.2] — 2026-09-28

### Added

- `X-OCG-Target` request header: the peer the inbound message came from, in OCG's
  own target vocabulary (`qqbot:c2c:<openid>`, `qqbot:group:<id>`, …). The body's
  `user` field only carries the session key (`qqbot:agent:main:main`), which the
  agent side cannot address — `/ocg/send` rejects it with
  `INVALID_TARGET` — so an agent that wants to send something back later had no
  way to learn a usable target. Sent on both the async and sync dispatch paths,
  and omitted when the peer is unknown.

---

## [1.2.1] — 2026-09-22

### Changed

- Proactive send loads the OpenClaw SDK chunking helpers
  (`openclaw/plugin-sdk/reply-chunking`) **lazily and optionally**: when a future
  openclaw release renames or removes that entry, only proactive send degrades —
  to the plugin's own `chunker` declaration, or failing that OCG's built-in
  splitter — instead of every `ocg` command failing at process start. Upstream has
  already removed one public entry this way (`plugin-sdk/outbound-runtime` is gone
  in openclaw 2026.9.5), so the guard is not hypothetical.

### Tests

- `src/send-test.ts`: 5 new assertions covering the "SDK helpers unavailable"
  path (chunking still bounded by the plugin's declared limit); 58 total.
- `docs/requirements-proactive-send.md` §3.7.5 records the upstream removal as
  evidence for choosing the plugin-primitive path.

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
