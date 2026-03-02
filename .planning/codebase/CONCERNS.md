# Codebase Concerns

**Analysis Date:** 2026-02-25

## Tech Debt

**Configuration Backup Proliferation:**
- Issue: 22 backup files of `openclaw.json` accumulated in root directory (`.bak`, `.bak-api-field`, `.bak-fix-model`, numbered variants)
- Files: `/Users/xavier/.openclaw/openclaw.json.bak*` (22 files totaling ~350KB)
- Impact: Configuration state unclear; difficult to understand current vs. intended configuration; historical backups create confusion about which version is authoritative
- Fix approach: Delete all numbered/dated backups except most recent one; establish versioning via git only

**Model Configuration Duplication:**
- Issue: Multiple provider configurations define identical models (e.g., `claude-opus-4-6` appears in both `anthropic` OAuth and `anthropic-api` providers; `gpt-5.3-codex` in both `openai` OAuth and `openai-api`)
- Files: `openclaw.json` lines 71-315 (model definitions)
- Impact: Inconsistent model availability between auth methods; difficult to maintain parity; redundant configuration
- Fix approach: Consolidate model definitions to single provider per API; use auth mode selector instead of duplicate provider definitions

**Missing API Field Warnings in History:**
- Issue: Configuration shows history of `.bak-api-field` and `.bak-fix-model` backups, suggesting recurring problems with model API field configuration
- Files: `openclaw.json.bak-api-field`, `openclaw.json.bak-fix-model`
- Impact: Indicates custom providers may have missing or incorrect `"api"` field specification; OpenAI custom providers need `"api": "openai-responses"`, Anthropic need `"api": "anthropic-messages"`
- Fix approach: Add validation in gateway to enforce required `api` field on all model definitions; document required fields per provider type

## Known Bugs

**Stuck Session Incidents (Active/Recurring):**
- Symptoms: Sessions report `state=processing age=XXXs` persisting for minutes (up to 8+ minutes observed in Feb 25 logs)
- Files: `/Users/xavier/.openclaw/logs/gateway.err.log`
- Trigger: Occurs during agent execution, especially cron-spawned tasks (`cron:*` session keys) and main agent processing
- Evidence:
  - `2026-02-25T16:47:30.660Z` session age 138s
  - `2026-02-25T16:53:00.686Z` session age 468s (7m 48s)
  - Multiple agents affected: `personal-admin`, `researcher`, `main`
- Workaround: Gateway drain timeout forces restart at 180s (`2026-02-25T13:16:46.387Z [gateway] drain timeout reached`)
- Root cause likely: Slow model responses, compaction/memory flush blocking, or timeout in external API calls

**Cron Task Delivery Failures:**
- Symptoms: `cron announce delivery failed` error in gateway logs
- Files: `logs/gateway.err.log`
- Trigger: Appears during cron job scheduling/execution
- Evidence: `2026-02-25T16:57:21.299-05:00 [cron:c07f3fb1-7f37-4e4b-9997-23ee30f39e8a] cron announce delivery failed`
- Impact: Scheduled tasks may not execute reliably; cron job outcomes unreliable
- Workaround: None documented; delivery queue accumulates (40 items currently queued)

**Deleted Session Files Accumulation:**
- Symptoms: 751 `.deleted.*` session files in agents/*/sessions/
- Files: `/Users/xavier/.openclaw/agents/*/sessions/*.jsonl.deleted.*`
- Impact: Orphaned session history consuming disk space; difficult to audit session lifecycle; unclear deletion strategy
- Fix approach: Implement automatic cleanup of `.deleted` files after retention period; document session deletion retention policy

## Security Considerations

**Environment Variables in Configuration:**
- Risk: `openclaw.json` contains references to unencrypted credential references like `"apiKey": "op://AI Ops/Google AI Studio/swe-team"`
- Files: `openclaw.json` lines 335-359 (Google AI Studio provider config)
- Current mitigation: Uses 1Password CLI reference syntax (`op://...`), requires 1Password vault access
- Recommendations:
  - Ensure `.env` files are never committed to git (check `.gitignore`)
  - Consider validating that all sensitive config goes through 1Password references
  - Audit whether any plaintext credentials exist in config backups

**Ollama Local Network Exposure:**
- Risk: Ollama service exposed on local network `http://100.91.2.71:11434` without documented authentication
- Files: `openclaw.json` line 317 (ollama baseUrl)
- Current mitigation: Limited to internal network only
- Recommendations: Verify firewall rules restrict Ollama port; consider TLS/authentication for Ollama endpoint if accessible outside trusted network

**Browser Evaluation Enabled:**
- Risk: Browser evaluation feature enabled globally (`"evaluateEnabled": true`)
- Files: `openclaw.json` lines 40-43 (browser config)
- Impact: Agents can execute arbitrary JavaScript in browser context; potential RCE via malicious prompts
- Recommendations: Consider restricting browser evaluation to specific agents or use content security policies

## Performance Bottlenecks

**Memory Directory Excessive Growth:**
- Problem: Memory directory at 121MB; memory backup at 119MB (242MB total for redundant memory)
- Files: `/Users/xavier/.openclaw/memory/`, `/Users/xavier/.openclaw/memory-backup-20260223/`
- Cause: Agent memory accumulating without pruning; agents storing full session history, learnings, and per-day context files
- Scaling path:
  - Implement automatic memory archival (compress files >90 days old)
  - Reduce memory retention window from 30+ days to 14 days
  - Add memory size budgets per agent workspace
  - Delete backup-20260223 directory after validation of current state

**Agents Directory Excessive Size:**
- Problem: `/Users/xavier/.openclaw/agents/` consuming 599MB of disk space
- Cause: Accumulated session logs (20 agent workspaces × ~30MB each of deleted JSONL session logs)
- Scaling path:
  - Implement log rotation on agent session JSONL files
  - Archive/compress deleted sessions older than 14 days
  - Set maximum session log file size (currently unbounded)
  - Current deleted sessions: 751 files suggests no cleanup strategy

**Workspace Directory Growth (1.1GB):**
- Problem: `/Users/xavier/.openclaw/workspace/` at 1.1GB with 2693 markdown files
- Cause: Accumulated reports, analysis documents, and kanban task history
- Scaling path:
  - Archive completed task directories monthly
  - Implement file size limits on report generation
  - Compress archived reports to .gz
  - Consider external archive/retrieval system

**Cron Logs Unbounded:**
- Problem: Cron run logs accumulating without rotation (runs directory has multiple JSONL files with no size limits)
- Impact: Future cron execution costs increase linearly with accumulated logs
- Fix approach: Implement cron log rotation (keep last 30 days, compress older)

**Compaction + Memory Flush Causes Long Processing Delays:**
- Problem: Session memory flush on compaction takes 4-7 minutes, causes stuck session warnings and webchat disconnects
- Files: `openclaw.json` lines 451-466 (compaction config)
- Impact: Users experience timeouts and session interruptions
- Current config: `"softThresholdTokens": 40000`, `"ttl": "15m"` on context pruning
- Fix approach:
  - Reduce memory flush prompt complexity
  - Implement incremental memory flushing instead of blocking flush
  - Increase session timeout threshold to handle compaction delays
  - Consider background memory flush on session idle instead of during active processing

## Fragile Areas

**Custom Provider Configuration:**
- Files: `openclaw.json` lines 333-380 (google-swe, google-shared, ollama providers)
- Why fragile: Missing `api` field specification caused past issues (evidenced by `.bak-api-field` backups); no schema validation on provider definitions
- Safe modification: Add schema validator before gateway startup; require explicit `api` field on all providers
- Test coverage: No visible validation tests for model provider configuration

**Model Fallback Chain:**
- Files: `openclaw.json` lines 385-427 (agents.defaults with empty fallbacks array)
- Why fragile: `"fallbacks": []` means if primary model fails, no retry logic; single point of failure
- Current state: Primary model `openai/gpt-5.3-codex` has no fallback defined
- Safe modification: Add at least two fallback models per agent (suggest: `anthropic-api/claude-opus-4-6`, `openai-api/gpt-5.2`)
- Impact: Session will fail completely if primary model unavailable

**Cron Task Execution Reliability:**
- Files: `logs/gateway.err.log` (cron delivery failures), `logs/gateway.log` (cron scheduler polling)
- Why fragile: Delivery failures logged but no retry mechanism visible; 40 items in delivery-queue suggests backlog
- Safe modification: Implement exponential backoff retry on delivery failures; add dead-letter queue for failed deliveries after N retries
- Monitor: Track delivery-queue depth; alert if > 100 items

**Session Timeout Configuration:**
- Files: `openclaw.json` line 469 (`"timeoutSeconds": 600`)
- Why fragile: 600s (10 minute) timeout insufficient for long-running tasks; compaction causes stuck sessions that trigger timeout
- Safe modification: Increase timeout to 1200s (20 minutes); implement progressive timeout increase for retried operations
- Test: Verify timeout doesn't break short tasks

## Scaling Limits

**Session Concurrency Cap:**
- Current capacity: `"maxConcurrent": 4` agents per host
- Limit: System can handle 4 agent sessions simultaneously; 5th session must wait
- Scaling path: Evaluate if limiting is hardware constraint or architectural choice; consider: CPU/memory per agent, network connections to AI APIs

**Subagent Spawning Depth:**
- Current capacity: `"maxSpawnDepth": 2` (agents can spawn subagents 2 levels deep)
- Limit: Prevents runaway spawning; also limits parallel task decomposition
- Scaling path: Monitor subagent spawn failures; consider increasing depth if decomposition tasks require 3+ levels

**Delivery Queue Capacity:**
- Current queue: 40 items pending delivery
- Risk: No visible max size; unbounded queue could consume memory
- Fix approach: Add circuit breaker at queue size 1000; implement dead-letter queue; monitor queue depth metrics

## Dependencies at Risk

**Ollama Local Model Provider:**
- Risk: Ollama endpoint at `100.91.2.71:11434` is non-standard IP (not localhost); single point of failure for local model inference
- Impact: If Ollama service down, `qwen3-coder:30b` model unavailable; no fallback defined
- Migration plan: Add fallback to cloud model if Ollama unavailable; implement health check before session start

**1Password CLI Integration:**
- Risk: All sensitive configuration references `op://` paths; system dependent on `op` CLI being available and authenticated
- Files: `openclaw.json` API key references use `op://` paths
- Impact: If 1Password vault inaccessible or CLI broken, all API calls fail
- Recommendations: Implement local env var fallback for 1Password references

**Memory Search Local-Only Mode:**
- Risk: `"provider": "local"` means all memory search happens in-process; no distributed search capability
- Files: `openclaw.json` lines 430-449 (memorySearch config)
- Impact: Large workspaces (121MB memory) cause slow searches; cannot distribute across machines
- Migration plan: When scaling to multiple hosts, implement remote vector search (Pinecone, Weaviate, etc.)

## Missing Critical Features

**Session State Recovery:**
- Problem: No visible session persistence or recovery mechanism; stuck sessions (5+ min old) indicate no graceful recovery
- Blocks: Long-running tasks, reliable task scheduling, fault tolerance across gateway restarts
- Recommendation: Implement session state snapshots to durable storage; resume on gateway restart

**Audit Log for Configuration Changes:**
- Problem: 22 backup files suggest manual config edits without formal change tracking
- Blocks: Understanding when/why configuration changed; rolling back bad changes safely
- Recommendation: Implement configuration version control with change descriptions; log all config modifications with timestamp/reason

**Health Check Endpoints:**
- Problem: No visible health check mechanism for dependent services (Ollama, 1Password, Model APIs)
- Blocks: Proactive failure detection; graceful degradation when services down
- Recommendation: Add health check endpoint that verifies all critical service dependencies

## Test Coverage Gaps

**Configuration Validation:**
- What's not tested: No schema validation for `openclaw.json`; no tests for model provider `api` field requirement
- Files: `openclaw.json` (all provider definitions)
- Risk: Invalid configuration silently fails at runtime; model provider misconfiguration goes undetected
- Priority: High (prevents API field issues documented in backups)

**Cron Delivery Reliability:**
- What's not tested: No visible tests for cron task delivery; failure modes not documented
- Files: `logs/gateway.log` (cron scheduler polling), `logs/gateway.err.log` (cron announce delivery failed)
- Risk: Scheduled tasks fail silently; delivery-queue accumulates with no alert
- Priority: High (currently experiencing delivery failures)

**Session Stuck State Recovery:**
- What's not tested: No tests for session recovery after timeout; stuck session behavior not validated
- Files: `logs/gateway.err.log` (stuck session diagnostics)
- Risk: Stuck sessions block users; forced timeout restarts may lose work
- Priority: High (actively occurring, blocks user workflow)

**Model Fallback Behavior:**
- What's not tested: No tests for primary model failure triggering fallback chain
- Files: `openclaw.json` agents.defaults.model (fallbacks array empty)
- Risk: Single model failure = session failure; no graceful degradation
- Priority: Medium (would improve resilience)

---

*Concerns audit: 2026-02-25*
