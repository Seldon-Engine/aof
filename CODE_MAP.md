# AOF Code Map

Agentic Ops Fabric — deterministic orchestration for multi-agent systems.  
TypeScript ESM | Node >= 22 | ~47K LOC source | 300 source files, 268 test files

---

## Execution Model (Phase 43 — daemon is single authority)

Since Phase 43 (`v1.15.0`), the `aof-daemon` is the **sole owner** of `AOFService`, the scheduler, the task store, permissions, project resolution, and event logging. The OpenClaw plugin is a **thin IPC bridge** that proxies tool calls over a Unix socket and long-polls the daemon for agent spawns.

```
OpenClaw Gateway process                          aof-daemon (launchd / systemd user service)
  src/plugin.ts                                    src/daemon/index.ts
    -> registerAofPlugin()                           -> startAofDaemon()
       src/openclaw/adapter.ts (145 LOC)                src/daemon/daemon.ts
         DaemonIpcClient (singleton)                       AOFService (sole instance)
         tool-registry loop -> IPC proxy  ---\              SelectingAdapter
         4/7 lifecycle hooks forward  ------ IPC -------->    primary:  PluginBridgeAdapter
         spawn-poller (long-poll)                             fallback: StandaloneAdapter
         runs agent in-gateway via              <--spawn---   SpawnQueue + PluginRegistry
         api.runtime.agent.runEmbeddedPiAgent
```

Transport is the same `daemon.sock` Unix socket that hosts `/healthz` + `/status` — no new ports, no new auth surface. Filesystem permissions (`0600`, same-uid) are the trust boundary.

### Deploy shapes

- **Plugin-bridge mode** (`daemon.mode = "plugin-bridge"`, `AOF_DAEMON_MODE`): OpenClaw loads the plugin; plugin attaches via long-poll; daemon dispatches through `PluginBridgeAdapter`. When no plugin is attached, tasks **hold in `ready/`** (D-12) — never deadlettered.
- **Standalone mode** (`daemon.mode = "standalone"`, default): No gateway plugin registered. Daemon dispatches via `StandaloneAdapter` (HTTP POST to external OpenClaw gateway). If a plugin ever attaches, the selector prefers it (least-surprising rule).

The in-process `AOFService` path that the plugin used to own (the `schedulerService` module singleton in pre-43 `openclaw/adapter.ts`) is **gone**. Plugin `register()` is idempotent — it only ensures a live `DaemonIpcClient` and the spawn-poller is started once (module-scope gate survives OpenClaw's per-session plugin reload cycle).

---

## Module Layering

Lower layers must not import from higher layers. Enforced by `madge --circular`.

```
config/          env vars, paths, Zod-validated singleton (+ daemon.mode key)
logging/         Pino structured logger factory
schemas/         Zod schemas (source of truth for all types)
store/           Filesystem task persistence (ITaskStore)
events/          JSONL event log, notification policy
projects/        Multi-project manifest, store factory
org/             Org chart loading, validation, linting
permissions/     RBAC decorator (PermissionAwareTaskStore)
dispatch/        Scheduler, executor, assignment, DAG eval
                   + PluginBridgeAdapter (43-05), SelectingAdapter (43-05)
ipc/             Unix-socket IPC surface (Phase 43 NEW)
protocol/        Agent message routing (AOF/1 protocol)
context/         Context assembly, budget, steward
memory/          Vector search (HNSW), FTS, hybrid search
tools/           Shared tool registry (+ project-management-tools, 43-08)
views/           Kanban, mailbox (derived from task state)
delegation/      Subtask delegation artifacts
drift/           Org chart <-> gateway drift detection
murmur/          Inter-agent review triggers
recovery/        Run artifacts, heartbeat, resume
trace/           Session trace capture and formatting
metrics/         Prometheus-compatible metric collection
openclaw/        Thin-plugin bridge (Phase 43 — gutted adapter.ts + new siblings)
mcp/             MCP protocol server
service/         AOFService orchestration (daemon-only post-43)
daemon/          Daemon lifecycle, health server, IPC mounting
packaging/       Installer, updater, wizard, migrations (007 Phase 43)
cli/             Commander.js commands (highest layer)
```

Full layering rules are in `ARCHITECTURE.md`.

---

## Installation Layout

AOF separates user data from code so the installer can wipe the code tree on upgrade without touching task state:

```
~/.aof/                   Code tree (installer-owned — wiped freely on upgrade)
├── bin/aof               CLI launcher
├── dist/…                Compiled JS + openclaw.plugin.json
├── node_modules/…        Pinned dependencies
└── data/                 User data — NEVER wiped
    ├── tasks/…           Markdown task files (status dirs)
    ├── events/*.jsonl    Event log
    ├── artifacts/…       Run artifacts, heartbeats
    ├── memory.db         SQLite vector + FTS store
    ├── projects.json     Multi-project manifest
    ├── daemon.sock       Unix socket (0600) — health + IPC (Phase 43)
    └── daemon.pid        Daemon liveness PID file
```

Canonical resolution lives in `src/config/paths.ts`:

```
DEFAULT_CODE_DIR   ~/.aof            (install root)
DEFAULT_DATA_DIR   ~/.aof/data       (preserved across upgrades)
resolveDataDir()   explicit arg > AOF_DATA_DIR env > getConfig().core.dataDir > default
daemonSocketPath() dataDir/daemon.sock
daemonPidPath()    dataDir/daemon.pid
```

`scripts/install.sh` preserves `DATA_DIR` via a stop-services → move-out → wipe-code → extract-tarball → restore-data cycle. Migration 006 (`006-data-code-separation.ts`) relocates legacy mixed-layout installs on first run after upgrade.

### Installer — daemon always installed (Phase 43 reversal)

Phase 43 D-01 reverses Phase 42's "skip daemon in plugin-mode" branch. The daemon is **mandatory infrastructure**: without it, the plugin has nothing to IPC to.

```
scripts/install.sh
├── install_daemon()  — always proceeds (Phase 43 D-01)
│   └── idempotent via `launchctl kickstart -k` (macOS) / `systemctl --user restart` (Linux)
├── --force-daemon    — deprecated no-op with warning (Phase 43 D-04)
├── --tarball PATH    — local-build testing (bypasses GitHub release fetch)
├── --data-dir        — guards against `--data-dir == --prefix` via canonical-path comparison
└── --prefix          — install root (default ~/.aof)
```

Migration 007 (`007-daemon-required.ts`, version-locked `1.15.0`) installs the launchd/systemd service on upgrade from pre-43 installs — idempotent existence check on the plist/unit file. No `down()`: rolling back would strand the thin plugin.

Integration coverage: `tests/integration/install-mode-exclusivity.test.ts` (darwin-only, `AOF_INTEGRATION=1`).

---

## IPC Surface (Phase 43)

`src/ipc/` is the new daemon-side IPC module. All routes mount onto the existing `daemon.sock` HTTP server (`src/daemon/server.ts`) via `attachIpcRoutes()`.

```
src/ipc/
├── schemas.ts              Zod source of truth for wire contracts
├── types.ts                IpcDeps bag + RouteHandler signature (leaf file, no cycles)
├── index.ts                Barrel — pure re-exports
├── http-utils.ts           readBody with payload-size cap
├── server-attach.ts        attachIpcRoutes() — mounts all routes
├── store-resolver.ts       buildDaemonResolveStore() + getStoreForActor()
│                             (moved from openclaw/adapter.ts — D-02 cleanup)
├── spawn-queue.ts          SpawnQueue (EventEmitter, FIFO, enqueue/claim/tryClaim)
├── plugin-registry.ts      Implicit attach-via-long-poll handle (D-11)
└── routes/
    ├── invoke-tool.ts      POST /v1/tool/invoke — dispatches against toolRegistry (D-06)
    ├── session-events.ts   POST /v1/event/{session-end,agent-end,before-compaction,message-received} (D-07 A1)
    ├── spawn-wait.ts       GET  /v1/spawns/wait — long-poll (~30s keepalive, 204 on timeout)
    └── spawn-result.ts     POST /v1/spawns/{id}/result — plugin-posted outcome
```

### Wire contracts (`src/ipc/schemas.ts`)

| Schema | Direction | Route |
|--------|-----------|-------|
| `InvokeToolRequest` / `InvokeToolResponse` / `IpcError` (+ `IpcErrorKind` enum) | plugin → daemon | `POST /v1/tool/invoke` |
| `SpawnRequest` | daemon → plugin | `GET /v1/spawns/wait` (200 body) |
| `SpawnResultPost` | plugin → daemon | `POST /v1/spawns/{id}/result` |
| `SessionEndEvent` / `AgentEndEvent` / `BeforeCompactionEvent` / `MessageReceivedEvent` | plugin → daemon | `POST /v1/event/*` |

- `InvokeToolRequest` uses `.strict()` — unknown envelope fields rejected. Inner `params` uses `z.record(z.string(), z.unknown())`; per-tool validation runs server-side via `toolRegistry[name].schema`.
- `InvokeToolResponse` uses a refined union so `{}` / `{ error: … }` don't silently match the result branch.
- `callbackDepth` flows in the envelope (not via `AOF_CALLBACK_DEPTH` env mutation) — keeps CLAUDE.md's env-exception surface at one.
- `pluginId` defaults to `"openclaw"` (D-13) — reserved for multi-plugin fan-out; no schema bump needed when a second plugin ships.

### Auth & trust boundary

`daemon.sock` is `0600` owned by the invoking user — same-uid is the trust boundary (D-08). `src/daemon/server.ts` explicitly `chmodSync(socketPath, 0o600)` after `listen()` (T-43-01 mitigation — relying on umask was race-prone). No tokens, no handshake, no rotation.

---

## Thin-plugin module (`src/openclaw/` — Phase 43)

Pre-43 `adapter.ts` was 393 LOC and instantiated `AOFService`, built stores, loaded the org chart, and self-started the scheduler. Post-43 it is 145 LOC and a thin bridge.

```
src/openclaw/
├── adapter.ts                145 LOC — registerAofPlugin(): tool-registry → IPC proxies,
│                             4/7 lifecycle hooks forward, starts spawn-poller, proxies
│                             /aof/status + /aof/metrics to daemon (Open Q4).
├── daemon-ipc-client.ts      Module-level singleton `ensureDaemonIpcClient({ socketPath })`.
│                             Uses `http.request({ socketPath })` NOT fetch — AbortSignal.timeout
│                             over Unix socket fetch is unreliable (RESEARCH Pitfall 4).
├── spawn-poller.ts           `startSpawnPollerOnce(client, api)` — module-scope gate survives
│                             OpenClaw's per-session plugin reload (Pitfall 3). Long-poll
│                             with 35_000ms waitForSpawn timeout (25s server keepalive + 5s
│                             grace + 5s buffer). Handler throws become
│                             { success: false, error: { kind: "exception" } }.
├── openclaw-executor.ts      OpenClawAdapter class retained for standalone/legacy path.
│                             NEW: `runAgentFromSpawnRequest(api, sr)` consumed by the
│                             spawn-poller. Shared helpers: `prepareEmbeddedRun` +
│                             `executeEmbeddedRun`.
├── status-proxy.ts           Thin IPC proxy for `/aof/status` + `/aof/metrics` gateway URLs
│                             (preserves pre-43 URL compatibility — dashboards keep working).
├── dispatch-notification.ts  `mergeDispatchNotificationRecipient(params, id, store)` —
│                             extracted from adapter.ts for reuse.
├── tool-invocation-context.ts  OpenClawToolInvocationContextStore — per-session route capture
│                             for notify-on-completion. Stays plugin-side (D-07): captured route
│                             is attached to aof_dispatch params BEFORE the IPC send.
├── openclaw-chat-delivery.ts   "openclaw-chat" subscription delivery kind (daemon-side logic,
│                             but file groups with openclaw idioms).
├── matrix-notifier.ts          message-tool adapter invoked by chat-delivery.
├── executor.ts, permissions.ts, types.ts  unchanged leaf files.
```

### Lifecycle hook routing (D-07 + A1)

| Hook | Forwarded? | Why |
|------|-----------|-----|
| `session_end` | **IPC forward** | mutates daemon-owned session routing |
| `agent_end` | **IPC forward** | mutates daemon-owned state |
| `before_compaction` | **IPC forward** | clears plugin caches + daemon state |
| `message_received` | **IPC forward** (A1) | calls `protocolRouter.route()` — daemon-owned |
| `message_sent` | local only | updates plugin `OpenClawToolInvocationContextStore` |
| `before_tool_call` | local only | capture tool-call id for mergeDispatchNotificationRecipient |
| `after_tool_call` | local only | clear captured tool-call |

### Tool proxy flow

1. OpenClaw invokes `execute(id, params)` on a plugin-registered tool.
2. If tool is `aof_dispatch`, `mergeDispatchNotificationRecipient` attaches the plugin-captured session route.
3. `DaemonIpcClient.invokeTool({ pluginId, name, params, actor, projectId, correlationId, toolCallId, callbackDepth })` posts to `/v1/tool/invoke`.
4. Daemon `attachIpcRoutes` → `invoke-tool.ts` resolves the permission-aware store via `ResolveStoreFn`, dispatches against `toolRegistry[name]`, returns `{ result } | { error }`.
5. Plugin unwraps `{ result }` into OpenClaw's `{ content: [{ type: "text", text }] }` shape; `{ error }` throws.

---

## Core Patterns

### Config Singleton

All env vars are read in one place. Result is Zod-validated, deep-frozen, and cached.

```
src/config/registry.ts
  getConfig()      -> read env -> Zod parse -> deepFreeze -> cache
  resetConfig(ovr) -> deep-merge overrides with Zod defaults (no env read; test isolation)
```

Notable Phase 43 key: `daemon.mode: z.enum(["plugin-bridge", "standalone"]).default("standalone")`, propagated from `AOF_DAEMON_MODE`. `AOF_CALLBACK_DEPTH` remains the **only** documented exception to config-only env access (still mutated cross-process in `dispatch/callback-delivery.ts`).

Filesystem paths resolve through `src/config/paths.ts` (`resolveDataDir`, `normalizePath`, `DEFAULT_DATA_DIR`, `DEFAULT_CODE_DIR`, `eventsDir`, `memoryDbPath`, `daemonSocketPath`, `daemonPidPath`) — never hardcode `~/.aof/...` subpaths in domain modules.

### Zod-First Schemas

```typescript
// src/schemas/task.ts
export const TaskFrontmatter = z.object({ ... });
export type TaskFrontmatter = z.infer<typeof TaskFrontmatter>;
```

`const` for the Zod object, `type` (same name) for the inferred type. Used throughout `src/schemas/` and `src/ipc/schemas.ts`.

### Structured Logging

```typescript
const log = createLogger('scheduler');
log.info({ op: 'poll', taskId }, 'dispatching');
log.error({ err, taskId }, 'spawn failed');
```

JSON to stderr. CLI user-facing output uses `console.*` (OK in `src/cli/` only).

### Store Abstraction

```
ITaskStore (interface, 20+ methods)
  |
  +-- FilesystemTaskStore (real: Markdown + YAML frontmatter files)
  +-- PermissionAwareTaskStore (decorator: org chart RBAC checks)
  +-- createMockStore() (test: typed vi.fn() stubs, pre-seedable)
```

All task mutations go through `ITaskStore`. Never call `serializeTask` + `writeFileAtomic` directly. Tasks live in `tasks/<status>/TASK-NNN.md` and physically move on status transitions.

Post-43, `PermissionAwareTaskStore` wraps **daemon-side**: `src/ipc/store-resolver.ts::buildDaemonResolveStore` loads the org chart once (cached) and returns a per-actor, per-project permission-aware store. Plugin no longer loads org charts.

### Tool Registry

One handler map, three consumers:

```
src/tools/tool-registry.ts      <- defines { schema, handler, description } per tool
src/mcp/tools.ts                <- MCP server loop, 5 per-tool overrides (hardcoded skip list)
src/ipc/routes/invoke-tool.ts   <- daemon's /v1/tool/invoke route dispatches here (Phase 43)
src/openclaw/adapter.ts         <- plugin's tool-registry loop registers IPC proxies
```

Tool functions are organized by domain:
- `task-crud-tools.ts` — create, update, edit, cancel
- `task-workflow-tools.ts` — DAG workflow operations
- `project-tools.ts` — project scope operations
- `project-management-tools.ts` — Phase 43: `aof_project_create`, `aof_project_list`, `aof_project_add_participant` (daemon is now the single writer for project filesystem mutations too)
- `query-tools.ts` — status reports, queries
- `context-tools.ts` — context loading
- `subscription-tools.ts` — task subscriptions

Each tool function takes `(ctx: ToolContext, input: T)` and returns a typed result.

### Event System

```
EventLogger            -> appends JSONL to events/YYYY-MM-DD.jsonl
Notifier               -> dedupes (5-min window), routes to channels
NotificationPolicy     -> severity, audience, batching rules
  /engine.ts
  /deduper.ts
  /batcher.ts
  /audience.ts
```

Phase 43 extends `src/schemas/event.ts::EventType` with `dispatch.held` — emitted by `assign-executor.ts` when the `no-plugin-attached` sentinel fires.

### Executor Interface

```
GatewayAdapter (interface — src/dispatch/executor.ts)
  spawnSession(context, opts)      -> SpawnResult
  getSessionStatus(sessionId)      -> SessionStatus
  forceCompleteSession(sessionId)  -> void

Implementations (all three used by the daemon post-43):
  PluginBridgeAdapter (primary)   — enqueues SpawnRequest onto SpawnQueue, awaits
                                     deliverResult() via POST /v1/spawns/{id}/result
                                     callback keyed by server-generated spawnId.
  StandaloneAdapter   (fallback)  — HTTP POST to external OpenClaw gateway.
  SelectingAdapter                — thin selector: PluginRegistry.hasActivePlugin()
                                     picks primary vs fallback; in plugin-bridge
                                     mode with no plugin attached returns the D-12
                                     "no-plugin-attached" sentinel.
  OpenClawAdapter                 — kept in-tree for the standalone/legacy in-process
                                     path and consumed by runAgentFromSpawnRequest.
  MockAdapter                     — configurable test double (auto-complete, fail modes).
```

---

## Dispatch Pipeline

The scheduler runs on a timer (default 30s) via `AOFService.pollAllProjects()` inside the daemon:

```
poll(store, config)
  1. store.list('ready')                  -> find dispatchable tasks
  2. buildDispatchActions(tasks, config)  -> produces SchedulerAction[]
     - check deps resolved
     - check lease not active
     - check resource not occupied
     - check throttle limits (per-team, global concurrency)
     - resolve target: routing.agent ?? routing.role ?? routing.team
  3. executeActions(actions, config)      -> per-type handler dispatch
     - "assign"       -> executeAssignAction() -> executor.spawnSession()
                          (executor is SelectingAdapter post-43)
     - "expire-lease" -> handleExpireLease()
     - "promote"      -> handlePromote()
     - "requeue"      -> handleRequeue()
     - "deadletter"   -> handleDeadletter()
     - "alert"        -> handleAssign() (alert variant)
```

Action handlers are extracted into:
- `lifecycle-handlers.ts` — assign, deadletter, expire-lease, promote, requeue
- `recovery-handlers.ts` — spawn failure recovery
- `alert-handlers.ts` — alert dispatch

### Hold-in-ready branch (D-12)

`src/dispatch/assign-executor.ts` adds a Phase 43 branch mirroring the existing platform-limit requeue path:

```
if (result.error === "no-plugin-attached") {
  releaseLease(store, taskId, agent)
  logger.log("dispatch.held", "scheduler", { taskId, payload: { reason, agent, correlationId } })
  return { executed: false, failed: false }
}
```

Task stays in `ready/`; retryCount is **not** incremented; deadletter is **not** triggered. Upholds PROJECT.md's core invariant: "tasks never get dropped." Covered by `tests/integration/hold-no-plugin.test.ts` + `plugin-session-boundaries.test.ts` + `daemon-restart-midpoll.test.ts`.

### Per-task spawn timeouts

`aof_dispatch` accepts an optional `timeoutMs` (Zod-validated, capped at `MAX_DISPATCH_TIMEOUT_MS = 4h` in `tools/project-tools.ts`). Stored in task metadata and consumed by `assign-executor.ts` at spawn time, overriding the daemon-level `spawnTimeoutMs` default. Flows through the `SpawnRequest` envelope to the plugin's spawn-poller unchanged.

### DAG Workflow Engine

Tasks can have multi-hop workflow DAGs defined in their frontmatter:

```
WorkflowDefinition -> hops[] (each hop: role, dependsOn, condition, timeout)
WorkflowState      -> per-hop state (status, result, agent, timestamps)

dag-evaluator.ts        -> evaluateDAG(): determines ready hops, cascades skips
dag-condition-evaluator -> evaluateCondition(): recursive condition expression eval
dag-transition-handler  -> handleDAGHopCompletion(): hop done -> advance state
dag-context-builder     -> buildHopContext(): context for hop dispatch
```

Hops have: pending -> ready -> in-progress -> done/skipped/rejected  
Conditions use a recursive Zod lazy schema (`ConditionExpr`) supporting AND/OR/NOT/field-match.

---

## Subsystems

### Daemon (`src/daemon/`)

```
daemon.ts         startAofDaemon() — constructs SpawnQueue + PluginRegistry +
                  StandaloneAdapter + PluginBridgeAdapter + SelectingAdapter upfront;
                  passes queue/registry to attachIpcRoutes; writes daemon.pid only
                  after healthcheck passes; drain-aware SIGTERM/SIGINT.
server.ts         createHealthServer() — Unix-socket HTTP server. Hosts
                  /healthz, /status, and post-43 mounts /v1/* via attachIpcRoutes.
                  Explicit chmodSync(socketPath, 0o600) after listen().
standalone-adapter.ts  GatewayAdapter via HTTP to external OpenClaw gateway —
                  retained as fallback for daemon-only installs (D-10).
health.ts         Shutdown flag shared with CLI.
service-file.ts   installService/uninstallService — writes launchd plist /
                  systemd user unit. Consumed by migration 007.
```

### Memory (`src/memory/`)

Hybrid search over agent-generated memories:

```
VectorStore        -> SQLite + HNSW index (hnswlib-node) + sqlite-vec fallback
FtsStore           -> SQLite FTS5 for BM25 text search
HybridSearchEngine -> combines vector + BM25 with configurable weights
Reranker           -> optional cross-encoder reranker (@huggingface/transformers)
```

Tiered storage: hot (1.0x boost), warm (0.8x), cold (0.5x). Embedding providers: OpenAI, Ollama. Chunking, curation policy, warm aggregation, hot promotion.

### Protocol Router (`src/protocol/`)

Handles AOF/1 protocol messages from agents:

```
ProtocolRouter.route(message)
  -> handleCompletionReport()   — agent says "done"
  -> handleStatusUpdate()       — agent progress update
  -> handleHandoffRequest()     — agent wants to delegate
  -> handleHandoffAck()         — delegation accepted
  -> handleSessionEnd()         — session cleanup
```

Router runs daemon-side; the `message_received` IPC forward (A1) is what drives `route()` on plugin-originated messages.

### Context Module (`src/context/`)

```
assembler.ts  -> assembleContext(): gathers context from resolvers within budget
steward.ts    -> calculateFootprint(): agent token usage tracking, transparency reports
budget.ts     -> context budget enforcement
handoff.ts    -> agent-to-agent context transfer rendering
skills.ts     -> skill definitions for agent context loading
```

### Org Chart (`src/schemas/org-chart.ts`, `src/org/`)

Defines agents, teams, roles, routing rules, memory policies, murmur triggers.  
The linter (`org/linter.ts`, 463 lines) validates structural integrity.  
Drift detector (`drift/detector.ts`) compares org chart against live OpenClaw agents.  
Daemon-side loader: `src/ipc/store-resolver.ts` calls `loadOrgChart()` once, caches, wraps with `PermissionAwareTaskStore` per resolved store.

### Views (`src/views/`)

Derived read-only views of task state:

- `kanban.ts` — Kanban board with swimlanes (priority/project/phase)
- `mailbox.ts` — Per-agent mailbox view
- `renderers.ts` — Markdown rendering for views
- `watcher.ts` — File watcher for live view updates

### Packaging (`src/packaging/`)

Installation and update management:

- `installer.ts` — install/update with backup and health checks
- `updater.ts` — version-aware updates
- `wizard.ts` — interactive setup wizard
- `migrations.ts` — numbered migration framework
- `migrations/` — 001 workflow template, 003 version metadata, 004 scaffold repair, 005 path reconciliation, 006 data-code separation, **007 daemon-required (Phase 43)**
- `ejector.ts` — remove AOF cleanly
- `snapshot.ts` — backup/restore (excludes non-regular files: sockets, FIFOs, devices)
- `channels.ts` — update channel management

Shell-side entry point `scripts/install.sh` owns:
- Preserve-wipe-restore upgrade cycle (stops services first to avoid write races)
- `install_daemon()` always runs (Phase 43 D-01)
- `--tarball PATH` flag for local-build testing (bypasses GitHub release fetch)
- `launchctl kickstart -k` for idempotent macOS daemon installs
- Tarball build: `scripts/build-tarball.mjs` emits `dist/openclaw.plugin.json` so plugin-mode loads regardless of install root

### OpenClaw Notification Delivery

Plugin-owned subscription-delivery subsystem that routes task state changes back to the originating chat session. Plugin-side hooks capture the OpenClawNotificationRecipient (sessionKey/sessionId/replyTarget/channel/threadId) and attach it to `aof_dispatch` params BEFORE the IPC send. The core-agnostic `SubscriptionDelivery` payload is emitted daemon-side by the `EventLogger` callback on task status transitions (blocked/review/done/cancelled/deadletter).

All OpenClaw-specific idioms stay inside `src/openclaw/`.

---

## Test Infrastructure

```
src/testing/harness.ts          -> createTestHarness(): tmpDir + real store + EventLogger
src/testing/mock-store.ts       -> createMockStore(): typed mock satisfying ITaskStore
src/testing/mock-logger.ts      -> createMockLogger(): vi.fn() Pino stubs
src/testing/task-reader.ts      -> readAllTasks(): parse tasks from disk
src/testing/event-log-reader.ts -> readEventLogEntries(): parse JSONL events
src/testing/metrics-reader.ts   -> getMetricValue(): read prom-client metrics
```

Test tiers:
- **Unit tests** (`src/**/__tests__/*.test.ts`): ~3,017 tests, 10s timeout. Root `vitest.config.ts` excludes `tests/integration/` and `tests/e2e/` from the unit run.
- **E2E tests** (`tests/e2e/suites/*.test.ts`): ~224 tests, sequential, single fork, 60s timeout
- **Integration tests** (`tests/integration/`): `plugin-load`, `dispatch-pipeline`, `gateway-dispatch`, `dep-cascade`, `notification-engine`, `sdlc-workflow`, `install-mode-exclusivity`, and Phase-43 additions: `tool-invoke-roundtrip`, `long-poll-spawn`, `hold-no-plugin`, `plugin-session-boundaries`, `daemon-restart-midpoll`. Run via `npm run test:integration:plugin`.

Naming convention for regression tests: `bug-NNN-description.test.ts`

### Test-lock watchdog (`scripts/test-lock.sh`)

Vitest's tinypool can leak child workers when runs are aborted (SIGTERM cleanup is unreliable). `test-lock.sh` wraps test invocations with a process-group watchdog that kills orphaned vitest workers on parent death. Manual cleanup rule after any aborted run (see CLAUDE.md):

```bash
ps -eo pid,command | grep -E "node \(vitest" | grep -v grep | awk '{print $1}' | xargs -r kill -9
```

---

## Feature Anatomy

A typical feature touches these layers:

```
1. Schema       -> src/schemas/foo.ts              (Zod schema + derived type)
2. Store        -> src/store/task-*.ts              (if task-related persistence)
3. Logic        -> src/dispatch/*.ts or module/     (business logic, daemon-side)
4. Tool         -> src/tools/foo-tools.ts           (handler + schema)
5. Registry     -> src/tools/tool-registry.ts       (register handler)
6. Tests        -> src/module/__tests__/*.test.ts
7. CLI (maybe)  -> src/cli/commands/foo.ts          (Commander.js command)
```

Plugin IPC proxies pick up new registry entries automatically — no plugin-side wiring needed. Tools that need adapter-specific behavior get explicit handler overrides in `mcp/tools.ts` (MCP skip-list is hardcoded — see Noted Issues).

---

## Conventions Quick Reference

| Area | Convention |
|------|-----------|
| Config | `getConfig()` from `config/registry.ts`. No `process.env` elsewhere. One exception: `AOF_CALLBACK_DEPTH`. |
| Logging | `createLogger('component')`. No `console.*` in core modules. |
| Schemas | Zod source of truth. `z.infer<>` for types. |
| Store | `ITaskStore` methods only. No direct serialize+write. |
| Tools | Register in `tool-registry.ts`. Domain-organized handler files. |
| Tests | Colocated `__tests__/`. Use `createTestHarness()` or `createMockStore()`. |
| Imports | `.js` extension in import paths (ESM). |
| Types | `I` prefix for store interfaces. PascalCase types. camelCase functions. |
| Cycles | Extract shared types to `types.ts` leaf files. Verify with `madge --circular`. |
| Barrels | `index.ts` must be pure re-exports, no function definitions. |
| IPC | Plugin posts via `DaemonIpcClient` singleton (`http.request({ socketPath })`, never fetch). Daemon routes mount in `src/ipc/server-attach.ts`. |

---

## Largest Files (potential extraction candidates)

| File | Lines | Notes |
|------|-------|-------|
| `store/task-store.ts` | 616 | Core store, already extracted helpers |
| `cli/commands/memory.ts` | 607 | CLI command module, many subcommands |
| `cli/commands/daemon.ts` | 599 | CLI command module |
| `dispatch/dag-evaluator.ts` | 588 | Complex DAG state machine |
| `cli/commands/setup.ts` | 588 | Interactive setup wizard + migration registry |
| `protocol/router.ts` | 550 | 8 handler methods, could extract |
| `schemas/workflow-dag.ts` | 538 | Complex schema + validation |
| `dispatch/scheduler.ts` | 531 | Core scheduler, already extracted helpers |
| `service/aof-service.ts` | 505 | AOFService orchestration (daemon-only post-43) |
| `packaging/wizard.ts` | 493 | Install wizard |
| `openclaw/openclaw-executor.ts` | 419 | Shared `prepareEmbeddedRun` + `executeEmbeddedRun` + runAgentFromSpawnRequest |

---

## Noted Issues

1. **`console.*` in `src/tools/task-seeder.ts`** (4 calls) — core module using console instead of structured logging.

2. **`console.warn` in `src/config/registry.ts:195`** — `warnUnknownVars()` uses console.warn. Bootstrap concern (Pino may not be initialized yet), but inconsistent with convention.

3. **Serena can't parse some files** — `events/logger.ts`, `events/notifier.ts`, `views/kanban.ts`, `views/mailbox.ts`, `events/notification-policy/engine.ts` fail Serena's TS parser. They compile and test fine. Use `Read` for those files during navigation.

4. **MCP tool override list is hardcoded** — `registerAofTools()` in `mcp/tools.ts` skips 5 tools by name via an inline array. If a new tool is added to the registry with the same name as an MCP-specific handler, the skip list must be manually updated.

5. **SelectingAdapter per-session sticky routing not implemented** — a spawn that landed on the `PluginBridgeAdapter` but whose plugin has since disconnected will report status via the fallback. Accepted behaviour for this wave; refinement deferred.

6. **OpenClaw plugin reload per session** — the gateway reloads the AOF plugin on every agent session start. Module-scope gates in `daemon-ipc-client.ts` and `spawn-poller.ts` survive reload; the design is "at most one live long-poll per plugin process." If OpenClaw ever changes its plugin lifecycle to spawn fresh processes, those gates stop helping — revisit.
