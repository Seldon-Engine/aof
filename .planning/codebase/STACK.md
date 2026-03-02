# Technology Stack

**Analysis Date:** 2026-02-25

## Languages

**Primary:**
- Python 3.x - Data processing, integrations, cron jobs, API interactions in `/Users/xavier/.openclaw/workspace/scripts/`
- JavaScript/Node.js - Email delivery, event processing, metrics export in `/Users/xavier/.openclaw/workspace/scripts/`

**Secondary:**
- Shell/Bash - Gateway health checks, utility scripts
- YAML - Configuration files (OpenTelemetry, observability)

## Runtime

**Environment:**
- Node.js (minimum v20) - Required by `clawhub` package; OpenClaw gateway runs on this runtime
- Python 3.7+ - Required for all integration scripts

**Package Manager:**
- npm - JavaScript dependencies
- pip - Python dependencies

**Lockfiles:**
- `package-lock.json` present at `/Users/xavier/.openclaw/`
- `requirements.txt` minimal at `/Users/xavier/.openclaw/workspace/tmp/`

## Frameworks

**Core:**
- `clawhub` 0.4.0 - CLI toolkit and core platform framework for OpenClaw agents
- OpenTelemetry (OTEL) - Observability integration (disabled by default in config)

**Testing:**
- Not detected - Test commands present in workspace package.json but no test framework configured

**Build/Dev:**
- Prometheus v2.50.1 - Metrics collection and visualization
- Grafana Loki 2.9.6 - Log aggregation and analysis
- Grafana Alloy v1.5.1 - Observability collector (replaces deprecated Promtail)

## Key Dependencies

**Critical:**
- `nodemailer` 6.10.1 - SMTP email delivery via Proton Bridge; used in `send_email.js`
- `clawhub` 0.4.0 - Core OpenClaw framework with agent CLI commands
- Python `imaplib` (stdlib) - IMAP email ingestion from Proton Bridge
- Python `email` (stdlib) - RFC822 message parsing for email processing

**Infrastructure:**
- Grafana LGTM Stack - Loki, Prometheus, Alloy for observability
- Prometheus client library (implicit via metrics exporter)
- psutil (optional) - OS metrics collection in `openclaw_metrics_exporter.py`
- requests (2.28.0+) - HTTP client for external API calls
- pydantic (2.0.0+) - Data validation for structured output
- PyNaCl - Cryptographic signing for Matrix cross-signing operations (`matrix_cross_sign.py`)

## Configuration

**Environment:**
OpenClaw uses multi-layered configuration:

1. **Central config:** `openclaw.json` at `/Users/xavier/.openclaw/`
   - Gateway settings (port 18789, local mode, token auth)
   - Model provider configuration (Anthropic, OpenAI, Google, Ollama)
   - Auth profiles for OAuth and API key modes
   - Diagnostics and logging settings
   - Browser automation settings
   - TailScale configuration

2. **Environment variables:** Set in `env.vars` section of `openclaw.json`:
   - `GOG_ACCOUNT` - GOG user account identifier
   - `SEARXNG_URL` - SearXNG instance URL (local Tailnet)
   - `SERENA_PROJECT_PATH` - Path to Serena LSP project

3. **Runtime env vars** (loaded by scripts):
   - `PROTON_BRIDGE_USER`, `PROTON_BRIDGE_PASS` - Proton Mail Bridge credentials
   - `PROTON_BRIDGE_IMAP_HOST`, `PROTON_BRIDGE_IMAP_PORT`, `PROTON_BRIDGE_IMAP_SECURITY` - IMAP config
   - `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN` - 1Password Connect API endpoint and token
   - Auth tokens from 1Password (fetched via `op read` command)

**Build:**
- No traditional build system detected
- Configuration validation via Python scripts (`auth_lint.py`, `gateway_health.py`)

## Platform Requirements

**Development:**
- macOS (Darwin) - Primary development platform
- Node.js 20+
- Python 3.7+
- Tailscale - For network access to internal services (100.65.243.89)
- Docker - For running observability stack (Loki, Prometheus, Alloy)
- 1Password CLI (`op` command) - For credential management
- Proton Mail Bridge - For local IMAP access to Proton Mail

**Production:**
- OpenClaw gateway runs as systemd/launchd service on macOS
- Deployment target: macOS with local gateway (port 18789)
- Tailscale mesh network for multi-machine agent coordination
- Observability stack deployable via Docker Compose

## Key Technology Integrations

**LLM Providers:**
- Anthropic Claude (OAuth and API key modes)
- OpenAI GPT (OAuth and API key modes)
- Google Gemini (via google-swe and google-shared providers)
- Ollama (local model inference)

**Credentials & Secrets:**
- 1Password - Primary credential store with Connect API integration
- OAuth token storage in `auth-profiles.json`
- Secrets directory at `/Users/xavier/.openclaw/workspace/secrets/` for local configs

**Observability:**
- OpenTelemetry Protocol (OTLP) - Traces and metrics export
- Prometheus metrics exposition on port 9100 (metrics_exporter.py)
- Loki for log aggregation (pushed to Mule Tailnet at 100.65.243.89:3100)
- Grafana UI integration (Alloy provides OTLP receiver on 4317/4318)

---

*Stack analysis: 2026-02-25*
