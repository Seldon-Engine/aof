# External Integrations

**Analysis Date:** 2026-02-25

## APIs & External Services

**Email & SMTP:**
- Proton Mail - Email provider for digest delivery
  - SDK/Client: `nodemailer` (6.10.1)
  - Transport: Proton Bridge local SMTP server
  - Auth: Stored in `/Users/xavier/.openclaw/workspace/secrets/proton-bridge.json`
  - Script: `send_email.js` for outbound digest mail

**Email Ingestion:**
- Proton Mail (IMAP) - Email ingestion via Bridge
  - SDK/Client: Python `imaplib` (stdlib)
  - Connection: localhost IMAP, STARTTLS
  - Creds: Stored in `/Users/xavier/.openclaw/workspace/secrets/proton-bridge.json`
  - Env vars: `PROTON_BRIDGE_USER`, `PROTON_BRIDGE_PASS`, `PROTON_BRIDGE_IMAP_HOST`, `PROTON_BRIDGE_IMAP_PORT`
  - Script: `proton_imap_ingest.py` - Polls unseen messages, creates Obsidian notes, maintains idempotency ledger

**Social Media:**
- Reddit - Post and comment extraction
  - SDK/Client: Built-in `urllib` with custom User-Agent
  - Auth: Public API (no authentication required)
  - Endpoint: `https://www.reddit.com/*.json` (Reddit JSON API)
  - Script: `reddit_extract.py` - Extracts full comment trees with configurable filtering

**Chat/Messaging:**
- Matrix (Element) - P2P messaging and identity
  - Homeserver: `https://m.servertree.net`
  - User ID: `@demerzel:m.servertree.net`
  - SDK/Client: Custom HTTP + `PyNaCl` (cryptographic signing)
  - Auth: Access token stored in `/Users/xavier/.openclaw/credentials/matrix/credentials.json`
  - Device signing keys: `/Users/xavier/.openclaw/workspace/matrix-identity-backup/cross-signing-keys.json`
  - Script: `matrix_cross_sign.py` - Signs devices, manages E2EE key sync

**Search:**
- SearXNG - Metasearch engine instance
  - URL: `http://100.65.243.89:8888` (local Tailnet)
  - Auth: None (internal only)
  - Integration: Environment variable `SEARXNG_URL`

**LLM Model Providers:**

| Provider | Mode | Auth | Models | Connection |
|----------|------|------|--------|-----------|
| Anthropic (OAuth) | token | OAuth credential | claude-opus-4-6, claude-sonnet-4-6 | https://api.anthropic.com |
| Anthropic API | api_key | API key (sk-ant-api*) | claude-sonnet-4-5, claude-opus-4-6, claude-haiku-4-5, claude-sonnet-4-6 | https://api.anthropic.com |
| OpenAI (OAuth) | token | OAuth credential | gpt-5.2, gpt-5.2-codex, gpt-5.3-codex | https://api.openai.com/v1 |
| OpenAI API | api_key | API key (sk-*) | gpt-5.2, gpt-5.2-codex, gpt-5.3, gpt-5.3-codex | https://api.openai.com/v1 |
| Google Gemini (OAuth) | token | OAuth credential | gemini-3-pro-preview | Google Cloud |
| Ollama | local | None | qwen3-coder:30b | Local model inference |

Auth profiles configured in `/Users/xavier/.openclaw/openclaw.json`:
- `anthropic:manual` - Token mode (manual entry)
- `anthropic-api:default` - API key mode
- `openai:default` - OAuth mode
- `openai-api:default` - API key mode
- `openai-codex:default` - OAuth mode (primary)

## Data Storage

**Databases:**
- Not detected - No traditional database service integrations

**File Storage:**
- Local filesystem only
  - Intel diary: `/Users/xavier/.openclaw/workspace/intel-diary/`
  - Mock vault: `/Users/xavier/.openclaw/workspace/mock-vault/`
  - Obsidian vault: `/Users/xavier/.openclaw/workspace/mock-vault/Resources/Comms/Proton Inbox/` (email notes)
  - Agent sessions: `/Users/xavier/.openclaw/agents/*/sessions/`
  - Logs: `/Users/xavier/.openclaw/logs/`

**Log Aggregation:**
- Loki (Grafana) - Log shipping destination
  - Endpoint: `http://100.65.243.89:3100/loki/api/v1/push` (Mule Tailnet)
  - Logs shipped: `gateway.log`, `gateway.err.log`
  - Script: `log_shipper.py` - Tails gateway logs, batches to Loki

**Caching:**
- None detected

## Authentication & Identity

**Auth Provider:**
- Anthropic OAuth - Primary for Claude models
- OpenAI OAuth - Primary for GPT models
- Google OAuth - For Gemini models
- Local/Manual - API key fallback modes

**Implementation:**
- OAuth credential storage in `auth-profiles.json` at `/Users/xavier/.openclaw/`
- Token refresh managed by OpenClaw gateway
- API key storage in same profiles file (prefer OAuth, fallback to API key)
- Token expiry tracking with automatic fallback to API keys
- Implemented in: `gateway_health.py`, `auth_profile_health.py`, `auth_lint.py`

**Secrets Management:**
- 1Password Connect API - External credential retrieval
  - Endpoint: Via `OP_CONNECT_HOST` env var
  - Token: `OP_CONNECT_TOKEN`
  - Vault/Item IDs: `<REDACTED>` (stored in 1Password Connect config)
  - Fallback: Local JSON secrets files in `/Users/xavier/.openclaw/workspace/secrets/`
  - Integration: `proton_imap_ingest.py` retrieves IMAP creds from 1Password Connect

**Local CLI:**
- 1Password CLI (`op` command) - Credential retrieval
  - Example: `op read op://AI\ Ops/Matrix/password` for Matrix password
  - Used in: `matrix_cross_sign.py`

## Monitoring & Observability

**Error Tracking:**
- Not configured for external service

**Logs:**
- OpenClaw gateway logs to `/Users/xavier/.openclaw/logs/gateway.{log,err.log}`
- Shipped to Loki via `log_shipper.py` (default: Mule Tailnet at 100.65.243.89:3100)
- Log entries tracked in `.log_shipper_state.json` for idempotency

**Metrics:**
- Prometheus metrics exposed on localhost:9100 at `/metrics`
- Exporter: `openclaw_metrics_exporter.py`
- Scraped metrics from:
  - Events JSONL: `/Users/xavier/.openclaw/logs/events.jsonl`
  - Metrics bridge: `/Users/xavier/.openclaw/logs/metrics-bridge.jsonl`
  - Cron runs: `/Users/xavier/.openclaw/cron/runs/*.jsonl`
  - Agent sessions: `/Users/xavier/.openclaw/agents/*/sessions/*.jsonl`
  - OS metrics: psutil (optional)

**Tracing/Diagnostics:**
- OpenTelemetry (disabled by default)
  - Endpoint: `http://100.65.243.89:4318` (Mule Tailnet, OTLP HTTP)
  - Protocol: `http/protobuf`
  - Service name: `openclaw-gateway`
  - Sample rate: 1.0 (100%)
  - Flush interval: 30000ms

## CI/CD & Deployment

**Hosting:**
- Local machine (Darwin/macOS)
- Gateway runs as background service (launchctl/systemd)
- Port 18789 (configurable)

**CI Pipeline:**
- Not detected - No CI/CD system found
- Manual health checks via `gateway_health.py`

**Service Health Checks:**
- Script: `gateway_health.py` - Validates auth profiles, provider connectivity, token expiry
- Script: `auth_profile_health.py` - Checks OAuth token expiry and API key validity

## Environment Configuration

**Required env vars:**

For Proton Bridge IMAP:
- `PROTON_BRIDGE_USER` - Proton Mail username (optional if config file present)
- `PROTON_BRIDGE_PASS` - Proton Mail password (optional if config file present)
- `PROTON_BRIDGE_IMAP_HOST` - IMAP server hostname (default: 127.0.0.1)
- `PROTON_BRIDGE_IMAP_PORT` - IMAP server port (default: 1143)
- `PROTON_BRIDGE_IMAP_SECURITY` - Security protocol (default: STARTTLS)

For 1Password Connect:
- `OP_CONNECT_HOST` - 1Password Connect server URL
- `OP_CONNECT_TOKEN` - Bearer token for Connect API

For logging/observability:
- `LOKI_URL` - Optional override for Loki push endpoint (default: http://100.65.243.89:3100/loki/api/v1/push)

**Secrets location:**
- Primary: `/Users/xavier/.openclaw/workspace/secrets/` (local JSON files)
  - `proton-bridge.json` - SMTP and IMAP credentials
- Fallback: 1Password Connect API via `OP_CONNECT_*` env vars
- Credentials stored in `~/.openclaw/credentials/` (e.g., `matrix/credentials.json`)

**Note on secrets in code:**
- `.env` files NOT used - Config-driven via `openclaw.json` and 1Password
- No hardcoded API keys in scripts
- Scripts are credential-agnostic; credentials loaded at runtime

## Webhooks & Callbacks

**Incoming:**
- Not detected - No webhook endpoints configured

**Outgoing:**
- Proton Bridge SMTP callback - Email delivery notifications are fire-and-forget
- Loki push API - Asynchronous log shipment (one-way)
- Matrix key signature API - Device signing updates (push-based)

## Gateway Configuration

**Local Network:**
- Port: 18789 (default)
- Mode: `local` (not exposed to network)
- Bind: `auto` (auto-detect interface)
- Auth: Token-based (stored in `~/.openclaw/openclaw.json` — ROTATE IF EXPOSED)
- TailScale: `serve` mode enabled (can expose via Tailscale)

**Allowed Tools:**
```
sessions_spawn, gateway, process, exec, read, write, edit, apply_patch, image,
sessions_list, sessions_history, sessions_send, subagents, session_status, cron, agents_list
```

**Trusted Proxies:**
- 127.0.0.1 only

---

*Integration audit: 2026-02-25*
