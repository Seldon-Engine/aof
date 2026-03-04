# AOF — Agentic Ops Fabric

## What This Is

AOF is a multi-team agent orchestration platform for OpenClaw. It turns an agent swarm into a reliable, observable, restart-safe operating environment — no LLMs in the control plane. Technical users install via curl|sh, configure teams and agents through an org chart, and walk away — tasks flow autonomously through agents without human intervention. Supports RevOps, ops, sales, marketing, research, and any domain where multiple AI agents collaborate.

## Core Value

Tasks never get dropped — they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

## Requirements

### Validated

- ✓ Filesystem-based task store with atomic rename() state transitions — existing
- ✓ Task lifecycle (backlog → ready → in-progress → review → done → deadletter) — existing
- ✓ Beads CLI (bd) for task CRUD, dependencies, promotion — existing
- ✓ Org chart schema (agents, teams, routing, memory pools, watchdog) — existing
- ✓ Org chart validation, linting, drift detection — existing
- ✓ Inter-agent protocols (AOF/1 envelope: completion reports, status updates, handoffs) — existing
- ✓ Scheduler with dispatch logic (dry-run and active modes) — existing
- ✓ Workflow gates (multi-stage review with rejection strategy) — existing
- ✓ Notification rules (severity tiers, deduplication, channel routing) — existing
- ✓ JSONL event logging (append-only, daily rotation) — existing
- ✓ Run artifacts + resume protocol for crash recovery — existing
- ✓ Lease-based task claims with heartbeat — existing
- ✓ SLA checking and violation events — existing
- ✓ Memory medallion pipeline (generate, audit, curate) — existing
- ✓ Kanban views and task board — existing
- ✓ Solid unit test foundation (vitest) — existing
- ✓ Restart-safe scheduler (poll timeout, drain, orphan reconciliation) — v1.0
- ✓ Failure classification (transient/permanent/rate_limited) with jittered backoff — v1.0
- ✓ Clean daemon lifecycle (start/stop/restart without orphaned state) — v1.0
- ✓ OS-supervised daemon (launchd/systemd with crash recovery) — v1.0
- ✓ Health endpoint (Unix socket, /healthz + /status, PID-gated startup) — v1.0
- ✓ GatewayAdapter abstraction (OpenClaw + Mock, config-driven selection) — v1.0
- ✓ Correlation ID tracking (dispatch → completion with force-complete) — v1.0
- ✓ HNSW memory auto-resize, startup parity check, crash-safe writes — v1.1
- ✓ CLI memory health and rebuild commands with progress output — v1.1
- ✓ CI validation workflow (typecheck/build/test on PR) — v1.1
- ✓ Tag-triggered release workflow with tarball artifacts and changelog — v1.1
- ✓ curl|sh installer with prerequisite detection, wizard, OpenClaw plugin wiring — v1.1
- ✓ Upgrade-safe installer (preserves tasks, events, memory data) — v1.1
- ✓ Multi-project isolation (tool scoping, dispatch filtering, per-project memory pools) — v1.1
- ✓ Audience-segmented documentation (guide/ for users, dev/ for contributors) — v1.1
- ✓ Auto-generated CLI reference from Commander.js command tree — v1.1
- ✓ Pre-commit hook preventing doc drift (4 checks) — v1.1

### Validated (v1.3)

- ✓ Migration framework with snapshot-based rollback — v1.3
- ✓ Three auto-migrations (defaultWorkflow, gate-to-DAG batch, version metadata) — v1.3
- ✓ DAG workflows as default for new tasks — v1.3
- ✓ `aof smoke` CLI health check (6 checks) — v1.3
- ✓ Tarball verification in CI release pipeline — v1.3
- ✓ UPGRADING.md with three upgrade paths + rollback docs — v1.3
- ✓ Legacy gate system fully removed — v1.3

### Current Milestone: v1.4 Context Optimization

**Goal:** Cut agent context injection by 50%+ while preserving full AOF capability — agents use less context but can still leverage DAG workflows, org chart setup, and all tools effectively.

**Target features:**
- Compressed companion skill (SKILL.md cheatsheet replacing verbose docs)
- Trimmed tool descriptions in adapter.ts (no redundancy with skill)
- Org chart setup guidance preserved for agent-led provisioning
- Measurable before/after token reduction

### Active

(Defining requirements for v1.4)

### Validated (v1.2)

- ✓ Per-task workflow DAG schema (templates + ad-hoc agent-composed pipelines) — v1.2
- ✓ Hop-based execution model (scheduler dispatches each hop independently) — v1.2
- ✓ Scheduler DAG advancement (evaluate graph on completion, dispatch eligible next hops) — v1.2
- ✓ Configurable hop behavior (auto-advance vs pause-for-review per hop) — v1.2
- ✓ Artifact handoff between hops via task work directory — v1.2
- ✓ Conditional branching and parallel execution within workflow DAGs — v1.2
- ✓ Pre-defined workflow templates in project config — v1.2
- ✓ Agent API for composing ad-hoc workflows at task creation time — v1.2
- ✓ Gate system replacement (review gates become review hops) — v1.2

### Out of Scope

- OpenClaw gateway development — AOF integrates with it, doesn't modify it
- UI/dashboard — CLI and JSONL observability sufficient for v1
- Multi-host distribution — single-machine deployment for now
- Non-OpenClaw runtimes — AOF is an OpenClaw plugin specifically
- OpenTelemetry integration — deferred to v2
- Self-healing (circuit breaker, dead-letter resurrection, stuck session recovery) — deferred to v1.5
- Agent-guided org chart setup — addressed in v1.4 (org chart guidance in compressed skill)
- Standalone daemon executor wiring — deferred to v1.5
- Memory search reranker — deferred to v1.5
- Memory tier auto compaction — deferred to v2
- Autoupdate mechanism — deferred to v2
- OpenClaw version compat checks — deferred to v2
- Basic telemetry collection — deferred to v2
- Kanban/mailbox view polish — deferred to v2
- Large task orchestration / agent subtask creation — partially addressed by v1.2 workflows, full scope deferred to v2
- npm registry publishing — distribution via GitHub Releases + installer

## Context

- AOF lives at `~/Projects/AOF/` — TypeScript project with src/, tests/, dist/
- Source structure: cli/, dispatch/, store/, protocol/, events/, org/, memory/, schemas/, daemon/, recovery/, gateway/, plugins/
- Builds with tsdown, tests with vitest (~90k LOC, 2400+ tests)
- Runtime data lands in `~/.openclaw/aof/` (events/, tasks/, state/, memory/)
- OpenClaw gateway is at `~/.openclaw/workspace/package/` — AOF uses its plugin-sdk export
- The org chart (`org/org-chart.yaml`) drives all routing, memory, and agent configuration
- v1.0 shipped: scheduler is restart-safe, daemon runs under OS supervision, gateway dispatch works via GatewayAdapter
- v1.1 shipped: memory fixed, CI pipeline live, curl|sh installer, multi-project isolation verified, documentation complete with guardrails
- v1.2 shipped: per-task workflow DAGs — tasks carry pipeline definitions (hops), scheduler executes DAG mechanically, replaces linear gate system. 27 requirements, 10 phases, 23 plans, ~100K LOC
- v1.3 shipped: seamless upgrade — migration framework, DAG-as-default, smoke tests, release pipeline, legacy gate removal
- OpenClaw constraint: no nested agent sessions — scheduler must advance hops between independent sessions
- Node 22 pinned as prerequisite (Node 24/25 have better-sqlite3 build failures)

## Constraints

- **Integration boundary**: Must use OpenClaw's `plugin-sdk` export — no gateway modifications
- **Deterministic control plane**: No LLM calls in scheduling/routing/state management
- **Filesystem-based**: No external database — atomic rename() for state transitions
- **Schema-first**: Zod schemas are source of truth, TypeScript types derived
- **Node 22**: Pinned as prerequisite — higher versions have native module build failures

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Plugin-sdk integration (not HTTP/CLI) | Tightest integration, survives gateway lifecycle | ✓ Good (GatewayAdapter via plugin-sdk) |
| Filesystem task store (no DB) | Zero dependencies, atomic ops, human-readable state | ✓ Good |
| YAML org chart (not JSON) | Human-readable config that non-devs can edit | ✓ Good |
| No LLMs in control plane | Deterministic scheduling = predictable behavior | ✓ Good |
| Agent-guided setup (not manual config) | Main agent interviews user to build org chart | — Pending (deferred to v1.2) |
| GatewayAdapter 3-method contract | Portable dispatch (spawnSession/getSessionStatus/forceCompleteSession) | ✓ Good |
| Unix socket for health (not TCP) | No port conflicts, no auth needed, OS-level isolation | ✓ Good |
| OS supervisor for restart (not in-process watchdog) | launchd/systemd handle crash recovery natively | ✓ Good |
| Correlation ID at dispatch time | UUID v4 threads through entire task lifecycle for tracing | ✓ Good |
| Save-after-write for HNSW (not batch) | Every mutation persists to disk — crash safety over throughput | ✓ Good |
| Startup parity check | HNSW-SQLite count mismatch triggers full rebuild | ✓ Good |
| Shell installer delegates to Node.js setup | Shell handles download, Node handles wizard/migrations/wiring | ✓ Good |
| Soft OpenClaw plugin wiring | Installs AOF even without OpenClaw, skips wiring with warning | ✓ Good |
| Per-project lazy memory initialization | Separate SQLite/HNSW per project, initialized on first use | ✓ Good |
| Audience-segmented docs (guide/ + dev/) | Users and contributors find relevant docs without cross-pollination | ✓ Good |
| Auto-generated CLI reference | Commander tree walk produces markdown — stays in sync with code | ✓ Good |
| Pre-commit hook for doc maintenance | Four checks prevent drift between code and documentation | ✓ Good |
| Product messaging: "multi-team agent orchestration platform" | Domain-agnostic positioning, not implementation-centric | ✓ Good |

---
*Last updated: 2026-03-04 after v1.4 milestone started*
