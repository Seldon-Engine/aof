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

### Validated (v1.4)

- ✓ Compressed SKILL.md (3411 → 1665 tokens, 51.2% reduction) — v1.4
- ✓ Tool descriptions verified as one-liner + schema (no redundancy) — v1.4
- ✓ Projects skill merged into single SKILL.md injection — v1.4
- ✓ Workflow parameter on aof_dispatch (string template, inline DAG, or false) — v1.4
- ✓ Org chart setup guidance preserved in compressed skill — v1.4
- ✓ Tiered context delivery: seed (563 tokens) and full (1665 tokens) tiers — v1.4
- ✓ Budget gate CI test enforces 2150-token ceiling on context injection — v1.4
- ✓ Before/after token measurement proving 50%+ reduction — v1.4

### Validated (v1.5)

- ✓ Completion enforcement — agents exiting without `aof_task_complete` are caught, marked failed, deadlettered — v1.5
- ✓ Dual-channel agent guidance (SKILL.md standing context + formatTaskInstruction per-dispatch reinforcement) — v1.5
- ✓ Streaming JSONL session parser for OpenClaw transcripts — v1.5
- ✓ No-op detection for zero-tool-call sessions — v1.5
- ✓ Structured trace capture with retry accumulation (`trace-N.json`) — v1.5
- ✓ `aof trace <task-id>` CLI with summary, `--debug`, `--json`, and DAG hop correlation — v1.5

### Validated (v1.8)

- ✓ Task notification subscriptions — subscribe at dispatch time or to existing tasks — v1.8
- ✓ Two granularity levels: `"completion"` (terminal states) and `"all"` (every state transition, batched) — v1.8
- ✓ Scheduler-driven callback delivery — spawns sessions to subscriber agents with task outcome as context — v1.8
- ✓ Callback retry (3 attempts, 30s cooldown) with delivery failure tracking — v1.8
- ✓ Callback depth limiting (MAX_DEPTH=3) prevents infinite callback loops across MCP boundary — v1.8
- ✓ Daemon restart recovery — pending subscriptions re-evaluated on first poll — v1.8
- ✓ Agent guidance for callback behavior, at-least-once delivery, idempotency expectations — v1.8
- ✓ Budget gate CI test enforces 2500-token ceiling on context injection — v1.8

### Validated (v1.10)

- ✓ Dead code removed (~2,900 lines — legacy gate system, unused MCP schemas, deprecated types) — v1.10
- ✓ Correctness bugs fixed (buildTaskStats counts, daemon startTime scope, UpdatePatch type, TOCTOU race via lock manager) — v1.10
- ✓ Centralized config registry (Zod-validated singleton, resetConfig() for test isolation, 11 process.env reads consolidated) — v1.10
- ✓ Structured logging (Pino with child loggers, 120+ console.* calls replaced, 36 silent catches remediated) — v1.10
- ✓ Code refactoring (god functions decomposed, tool registration unified, callback/trace helpers deduplicated) — v1.10
- ✓ Architecture fixes (0 circular deps, store abstraction enforced, config→org layering fixed, memory barrel split) — v1.10
- ✓ Test infrastructure (createTestHarness adopted by 13 files, typed mock factories, coverage expanded to all src/) — v1.10

### Validated (v1.15)

- ✓ Thin-plugin / daemon-as-single-authority — OpenClaw plugin is a bridge to aof-daemon over Unix-domain socket at `~/.aof/data/daemon.sock`; the in-plugin `AOFService` singleton is removed (D-02) — v1.15
- ✓ Daemon always installed — installer and Migration 007 install the launchd/systemd user service unconditionally; Phase 42 plugin-mode skip branch removed (D-01, D-14) — v1.15
- ✓ `--force-daemon` demoted to deprecated no-op with stderr warning; flag retained for one release cycle for CI/script compatibility (D-04) — v1.15
- ✓ Seven new IPC routes over daemon.sock: `POST /v1/tool/invoke`, four `POST /v1/event/*` (session-end, agent-end, before-compaction, message-received), `GET /v1/spawns/wait`, `POST /v1/spawns/{id}/result` (D-05) — v1.15
- ✓ Single `invokeTool` envelope dispatches against shared tool-registry — adding a new tool requires no new IPC route (D-06) — v1.15
- ✓ Selective session-event forwarding — 4 state-mutating hooks forward to daemon, 3 capture hooks stay local in the plugin (D-07) — v1.15
- ✓ Socket permissions: `daemon.sock` created with mode `0600`, trust boundary = invoking Unix uid (D-08) — v1.15
- ✓ Long-poll spawn callback — plugin pulls `SpawnRequest` via `GET /v1/spawns/wait`, invokes `runEmbeddedPiAgent` inside gateway, posts outcome via `POST /v1/spawns/{id}/result` (D-09) — v1.15
- ✓ PluginBridgeAdapter alongside retained StandaloneAdapter — dispatch-time selection based on attached-plugin presence (D-10) — v1.15
- ✓ Implicit plugin registration via active long-poll presence; auto-release on socket close (D-11) — v1.15
- ✓ No-plugin-attached → tasks held in `ready/` (not deadlettered); upholds "tasks never get dropped" invariant (D-12) — v1.15
- ✓ Multi-plugin design-ready — `pluginId` field reserved (Zod-optional, defaults to `"openclaw"`) in IPC envelopes; only openclaw plugin wired this release (D-13) — v1.15

### Active

(No active milestone — planning next)

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
- Self-healing (circuit breaker, dead-letter resurrection, stuck session recovery) — deferred to v2
- Agent-guided org chart setup — addressed in v1.4 (org chart guidance in compressed skill, agent-led provisioning)
- Standalone daemon executor wiring — addressed in v1.15 (StandaloneAdapter retained for daemon-only installs; PluginBridgeAdapter selected when plugin attached)
- Memory search reranker — deferred to v2
- Memory tier auto compaction — deferred to v2
- Autoupdate mechanism — deferred to v2
- OpenClaw version compat checks — deferred to v2
- Basic telemetry collection — deferred to v2
- Kanban/mailbox view polish — deferred to v2
- Large task orchestration / agent subtask creation — partially addressed by v1.2 workflows, full scope deferred to v2
- npm registry publishing — distribution via GitHub Releases + installer
- Non-OpenClaw plugins (slack, cli, other gateways) — v1.15 IPC contract is design-ready via reserved `pluginId` field; wiring deferred to a follow-up phase
- Remote daemon over TCP/HTTP — Unix socket only per v1.15 D-08; PROJECT.md single-machine constraint unchanged

## Context

- AOF lives at `~/Projects/AOF/` — TypeScript project with src/, tests/, dist/
- Source structure: cli/, dispatch/, store/, protocol/, events/, org/, memory/, schemas/, daemon/, recovery/, gateway/, plugins/, ipc/
- Builds with tsdown, tests with vitest (~107k LOC, 3,017 tests)
- Runtime data lands in `~/.aof/data/` (events/, tasks/, state/, memory/, daemon.sock, daemon.pid)
- OpenClaw gateway is at `~/.openclaw/workspace/package/` — AOF uses its plugin-sdk export
- The org chart (`org/org-chart.yaml`) drives all routing, memory, and agent configuration
- v1.0 shipped: scheduler is restart-safe, daemon runs under OS supervision, gateway dispatch works via GatewayAdapter
- v1.1 shipped: memory fixed, CI pipeline live, curl|sh installer, multi-project isolation verified, documentation complete with guardrails
- v1.2 shipped: per-task workflow DAGs — tasks carry pipeline definitions (hops), scheduler executes DAG mechanically, replaces linear gate system
- v1.3 shipped: seamless upgrade — migration framework, DAG-as-default, smoke tests, release pipeline, legacy gate removal
- v1.4 shipped: context optimization — compressed SKILL.md (51% reduction), tiered delivery (seed/full), workflow API on aof_dispatch, CI budget gate
- v1.5 shipped: event tracing — completion enforcement, session trace capture, `aof trace` CLI with DAG hop correlation
- v1.8 shipped: task notifications — subscription API, callback delivery with retry, all-granularity batching, depth limiting, restart recovery
- v1.10 shipped: codebase cleanups — dead code removal, bug fixes, centralized config, structured logging, code refactoring, architecture fixes, test infrastructure
- v1.15 shipped: thin-plugin / daemon-as-single-authority — plugin-to-daemon IPC over Unix socket, PluginBridgeAdapter, Migration 007 (always-install daemon), 0600 socket perms, no-plugin-attached hold-not-drop invariant, pluginId envelope reservation for future fan-out
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
| Workflow param as z.union (string\|object\|false) | Clean polymorphic input — template name, inline DAG, or explicit skip | ✓ Good |
| SKILL.md compression (not elimination) | Agents still need guidance for DAG workflows and org chart setup | ✓ Good (51% reduction) |
| Static tier selection (not LLM-decided) | Deterministic, no overhead — caller specifies seed or full | ✓ Good |
| Budget gate CI test (not manual measurement) | Automated regression prevention for context size | ✓ Good |
| Seed tier default for dispatched tasks | Simple tasks shouldn't pay full context cost | ✓ Good (82.5% reduction for seed) |
| Block-only enforcement (no warn mode) | Agents that skip aof_task_complete are always blocked — simplicity over configurability | ✓ Good |
| Dual-channel agent guidance (SKILL.md + formatTaskInstruction) | Standing context for general rules, per-dispatch reinforcement with consequences | ✓ Good |
| Streaming JSONL parsing (node:readline) | Memory-efficient line-by-line processing for potentially large session files | ✓ Good |
| Trace capture after enforcement (observational) | Tracing never interferes with task state transitions — purely diagnostic | ✓ Good |
| DAG hop correlation via correlationId with sequential fallback | Graceful degradation when correlation IDs are missing | ✓ Good |
| Co-located subscriptions.json (not frontmatter) | Subscriptions are multi-entry; frontmatter is single-value | ✓ Good |
| Constructor-injected taskDirResolver for SubscriptionStore | Testability and decoupling from store internals | ✓ Good |
| Subscription creation before executor dispatch | Atomic subscribe+dispatch — no window where task completes before subscription exists | ✓ Good |
| Callback prompt uses taskFileContents for structured notification | Subscriber gets full task state, not just ID | ✓ Good |
| Delivery failures tracked with counter+timestamp | 30s cooldown, 3 max attempts, self-healing retry | ✓ Good |
| Org chart validation on all subscribe operations | Even default "mcp" subscriberId must be in org chart | ✓ Good |
| Cursor-based scanning with lastDeliveredAt | High-water mark into EventLogger.query — self-healing on failure | ✓ Good |
| MAX_CALLBACK_DEPTH=3 as non-configurable constant | Safety simplicity — no runtime configuration surface for loop prevention | ✓ Good |
| TaskContext.metadata for callbackDepth propagation | Cross-session depth tracking without schema changes to gateway | ✓ Good |
| AOF_CALLBACK_DEPTH env var bridge for MCP boundary | Only mechanism that crosses OpenClaw agent spawn boundary | ✓ Good (accepted race window) |
| Budget ceiling 2500 tokens with 30% reduction baseline | ~10% headroom over measured 2268 total after v1.8 SKILL.md growth | ✓ Good |
| Zod-based config registry (not dotenv) | Typed validation at load, lazy init, resetConfig() for test isolation | ✓ Good |
| Pino for structured logging (not winston) | JSON output, child loggers, low overhead, pino-pretty for dev | ✓ Good |
| Shared lock manager for TOCTOU mitigation | InMemoryTaskLockManager shared across ProtocolRouter and Scheduler | ✓ Good |
| Tool registry pattern for MCP/OpenClaw unification | Single handler implementation, thin adapter layer per transport | ✓ Good |
| Dependency inversion for config→org cycle | Linter passed as optional parameter to break upward import | ✓ Good |
| ITaskStore.save/saveToPath for store encapsulation | All persistence routed through interface, no direct serialize+write | ✓ Good |
| createTestHarness() for test setup unification | One function creates tmpDir, store, logger, events — adopted by 13 files | ✓ Good |
| Daemon-as-single-authority (v1.15 D-02) | Eliminates dual-code-path fragility between plugin and standalone modes; one writer per install | ✓ Good |
| Unix-socket IPC over TCP for plugin-daemon bridge (v1.15 D-05) | Zero new ports, zero auth surface, lowest latency; same idiom as existing health socket | ✓ Good |
| Single `invokeTool` envelope (v1.15 D-06) | Adding a tool requires no new IPC route; mirrors toolRegistry unification from v1.10 | ✓ Good |
| Long-poll spawn callback vs inbound plugin socket (v1.15 D-09) | OpenClaw plugin-sdk doesn't expose inbound listeners; pull-model is proven pattern (GH Actions runners, Buildkite agents) | ✓ Good |
| Implicit plugin registration via long-poll presence (v1.15 D-11) | No separate register/deregister handshake, survives OpenClaw's per-session reload cycle | ✓ Good |
| No-plugin-attached → hold in ready, not deadletter (v1.15 D-12) | Upholds core-value invariant — gateway reloads must not drop tasks | ✓ Good |
| `pluginId` reserved in IPC envelopes (v1.15 D-13) | Future non-openclaw plugins (slack, cli) can attach without schema bumps | ✓ Good |
| Migration 007 idempotent, no `down()` (v1.15 D-14) | Matches 005/006 precedent; canonical v1.15 rollback is "install older version" | ✓ Good |
| `--force-daemon` demoted to deprecated no-op (v1.15 D-04) | Preserves v1.14 CI/script compatibility for one release cycle; flag removed in future | ✓ Good |

---
*Last updated: 2026-04-17 after v1.15 Phase 43 shipped*
