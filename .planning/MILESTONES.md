# Milestones

## v1.8 Task Notifications (Shipped: 2026-03-12)

**Phases completed:** 6 phases (28-33), 9 plans
**Timeline:** 2026-03-09 → 2026-03-12 (4 days)
**Code:** +3,970 lines across 22 files (~109k LOC TypeScript, 3,090 tests)

**Key accomplishments:**
- Subscription schema + SubscriptionStore with crash-safe co-located persistence (subscriptions.json per task)
- MCP tools for subscribe/unsubscribe + dispatch-time subscription via `subscribe` param on `aof_dispatch`
- Scheduler-driven callback delivery — spawns sessions to subscriber agents with task outcome as context
- Retry with 3-attempt max, 30s cooldown, and delivery failure tracking
- All-granularity delivery with cursor-based batching (lastDeliveredAt high-water mark into EventLogger.query)
- Callback depth limiting (MAX_DEPTH=3) prevents infinite callback loops across MCP boundary
- Daemon restart recovery — pending subscriptions re-evaluated on first poll after restart
- Agent guidance in SKILL.md documenting callback behavior, at-least-once delivery, idempotency expectations
- Budget gate CI test adjusted to 2500-token ceiling with 30% reduction baseline

**Git range:** eca7506 → 56e01d3

---

## v1.5 Event Tracing (Shipped: 2026-03-08)

**Phases completed:** 3 phases (25-27), 6 plans
**Timeline:** 2026-03-07 → 2026-03-08 (2 days)
**Code:** +6,600 / -88 lines across 47 files

**Key accomplishments:**
- Completion enforcement — agents exiting without `aof_task_complete` are caught, marked failed, and deadlettered after 3 strikes
- Dual-channel agent guidance — SKILL.md (standing context) + formatTaskInstruction (per-dispatch reinforcement with consequences)
- Streaming JSONL session parser extracts tool calls, reasoning, and output from OpenClaw transcripts
- No-op detection flags zero-tool-call sessions as suspicious via `completion.noop_detected` events
- Structured trace capture — `trace-N.json` files written atomically to task artifacts with retry accumulation
- `aof trace <task-id>` CLI with summary, `--debug`, `--json` modes and DAG hop correlation via `buildHopMap()`

**Git range:** feat(25-01) → docs(phase-27)

---

## v1.4 Context Optimization (Shipped: 2026-03-04)

**Phases completed:** 4 phases (21-24), 6 plans, 39 commits
**Timeline:** 2026-03-03 → 2026-03-04 (1 day)
**Code:** +3,767 / -580 lines across 47 files (~101k LOC TypeScript)

**Key accomplishments:**
- Compressed SKILL.md from 3411 to 1665 tokens (51.2% reduction) with full tool/workflow/protocol coverage
- Added workflow parameter to aof_dispatch for agent-composed DAG pipelines (string template, inline DAG, or false)
- Created tiered context delivery — seed tier (563 tokens) for simple tasks, full tier (1665 tokens) for complex tasks
- Budget gate CI test enforces 2150-token ceiling on total context injection, preventing regression
- Seed tier achieves 82.5% reduction vs pre-v1.4 full injection
- Consolidated projects skill into single SKILL.md injection (eliminated separate file)

**Git range:** feat(21-01) → docs(v1.4 audit)

---

## v1.3 Seamless Upgrade (Shipped: 2026-03-04)

**Phases completed:** 4 phases (17-20), 7 plans
**Timeline:** 2026-03-04 (single day)

**Key accomplishments:**
- Migration framework with snapshot-based rollback and marker file resumption
- Three auto-migrations: defaultWorkflow, gate-to-DAG batch conversion, version metadata
- DAG workflows as default for new tasks via resolveDefaultWorkflow
- `aof smoke` CLI command with 6 health checks
- Tarball verification script + CI release pipeline gate
- UPGRADING.md with three upgrade paths and rollback documentation
- Legacy gate system fully removed (gate-transition-handler deleted, tests rewritten to DAG)

---

## v1.2 Task Workflows (Shipped: 2026-03-03)

**Phases completed:** 7 phases, 16 plans, 0 tasks

**Key accomplishments:**
- (none recorded)

---

## v1.0 AOF Production Readiness (Shipped: 2026-02-26)

**Phases completed:** 3 phases, 7 plans, 15 commits
**Timeline:** 2026-02-25 (single day)
**Code:** +3,527 / -584 lines across 64 files

**Key accomplishments:**
- Restart-safe scheduler with poll timeout guard, graceful drain, and startup orphan reconciliation
- Three-way error classification (transient/permanent/rate_limited) with jittered backoff and dead-letter failure chains
- OS-supervised daemon with launchd (macOS) and systemd (Linux) service files and automatic crash recovery
- Unix socket health server with /healthz liveness and /status operational overview, PID-gated startup
- GatewayAdapter abstraction with OpenClaw and Mock implementations, config-driven adapter selection
- End-to-end dispatch tracking with UUID v4 correlation IDs and adapter-mediated force-complete on stale heartbeats

**Tech debt accepted:** 9 items (see v1.0-MILESTONE-AUDIT.md)

---


## v1.1 Stabilization & Ship (Shipped: 2026-02-27)

**Phases completed:** 6 phases (4-9), 16 plans, 40 commits
**Timeline:** 2026-02-25 → 2026-02-26 (2 days)
**Code:** +7,583 / -4,865 lines across 148 files (~90k LOC TypeScript)

**Key accomplishments:**
- Fixed P0 HNSW memory crash — auto-resize, startup parity check, crash-safe writes, CLI health/rebuild tools
- Added CI pipeline — GitHub Actions validation on PRs + tag-triggered release with tarball artifacts and changelog
- Built curl|sh installer — prerequisite detection, download/extract, wizard scaffolding, OpenClaw plugin wiring, upgrade-safe
- Verified and completed multi-project isolation — project-scoped dispatch, per-project memory pools, participant filtering
- Fixed production dependency gap — @inquirer/prompts in production deps, corrected repo URL
- Complete documentation — audience-segmented docs, auto-generated CLI reference, pre-commit guardrails, architecture overview

**Git range:** feat(04-01) → docs(09-05)
**Tech debt accepted:** See v1.1-MILESTONE-AUDIT.md (stale — all gaps resolved by Phases 7, 8, 9)

---

