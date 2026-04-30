# AOF Code Map

Agentic Ops Fabric — deterministic orchestration for multi-agent systems.  
TypeScript ESM | Node >= 22 | ~50K LOC source | 314 source files, 295 test files

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
artifacts/       Long-term artifact archive (tar.zst + SQLite index, Phase 999.4)
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
├── chat-delivery-queue.ts  ChatDeliveryQueue — enqueueAndAwait() returns a promise the
│                             daemon-side QueueBackedMessageTool awaits; deliverResult()
│                             settles it on plugin ACK. Powers notify-on-completion.
├── plugin-registry.ts      Implicit attach-via-long-poll handle (D-11)
└── routes/
    ├── invoke-tool.ts      POST /v1/tool/invoke — dispatches against toolRegistry (D-06)
    ├── session-events.ts   POST /v1/event/{session-end,agent-end,before-compaction,message-received} (D-07 A1)
    ├── spawn-wait.ts       GET  /v1/spawns/wait — long-poll (~30s keepalive, 204 on timeout)
    ├── spawn-result.ts     POST /v1/spawns/{id}/result — plugin-posted outcome
    ├── delivery-wait.ts    GET  /v1/deliveries/wait — chat-delivery long-poll (same pattern)
    └── delivery-result.ts  POST /v1/deliveries/{id}/result — plugin-posted delivery outcome
```

### Wire contracts (`src/ipc/schemas.ts`)

| Schema | Direction | Route |
|--------|-----------|-------|
| `InvokeToolRequest` / `InvokeToolResponse` / `IpcError` (+ `IpcErrorKind` enum) | plugin → daemon | `POST /v1/tool/invoke` |
| `SpawnRequest` | daemon → plugin | `GET /v1/spawns/wait` (200 body) |
| `SpawnResultPost` | plugin → daemon | `POST /v1/spawns/{id}/result` |
| `ChatDeliveryRequest` | daemon → plugin | `GET /v1/deliveries/wait` (200 body) |
| `ChatDeliveryResultPost` | plugin → daemon | `POST /v1/deliveries/{id}/result` |
| `SessionEndEvent` / `AgentEndEvent` / `BeforeCompactionEvent` / `MessageReceivedEvent` | plugin → daemon | `POST /v1/event/*` |

- `InvokeToolRequest` uses `.strict()` — unknown envelope fields rejected. Inner `params` uses `z.record(z.string(), z.unknown())`; per-tool validation runs server-side via `toolRegistry[name].schema`.
- `InvokeToolResponse` uses a refined union so `{}` / `{ error: … }` don't silently match the result branch.
- `callbackDepth` flows in the envelope (not via `AOF_CALLBACK_DEPTH` env mutation) — keeps CLAUDE.md's env-exception surface at one.
- `pluginId` defaults to `"openclaw"` (D-13) — reserved for multi-plugin fan-out; no schema bump needed when a second plugin ships.

### Auth & trust boundary

`daemon.sock` is `0600` owned by the invoking user — same-uid is the trust boundary (D-08). `src/daemon/server.ts` explicitly `chmodSync(socketPath, 0o600)` after `listen()` (T-43-01 mitigation — relying on umask was race-prone). No tokens, no handshake, no rotation.

---

## Thin-plugin module (`src/openclaw/` — Phase 43+)

Pre-43 `adapter.ts` was 393 LOC and instantiated `AOFService`, built stores, loaded the org chart, and self-started the scheduler. Post-43 it is 197 LOC and a thin bridge. Phase 44+ added subscription-delivery typing and per-process worker hygiene (registrationMode guard + plugin-service registration).

```
src/openclaw/
├── adapter.ts                197 LOC — registerAofPlugin(): registrationMode guard
│                             (early-return when not "full"), tool-registry → IPC proxies,
│                             4/7 lifecycle hooks forward, /aof/status + /aof/metrics
│                             proxy (auth: "gateway"). Wraps spawn-poller + chat-delivery-poller
│                             as `api.registerService({ id, start, stop })` so OpenClaw's
│                             gateway-only `startPluginServices` confines them to one process
│                             (workers no longer leak long-poll handles — see plugin-services
│                             note below).
├── daemon-ipc-client.ts      Module-level singleton `ensureDaemonIpcClient({ socketPath })`.
│                             Uses `http.request({ socketPath })` NOT fetch — AbortSignal.timeout
│                             over Unix socket fetch is unreliable (RESEARCH Pitfall 4).
├── spawn-poller.ts           `startSpawnPollerOnce(client, api)` + `stopSpawnPoller()`.
│                             Long-poll with 30_000ms wait. Module-scope gate is now a
│                             defense-in-depth against same-process re-register (config reload);
│                             gateway-vs-worker isolation is enforced by service registration
│                             upstream. Handler throws become
│                             { success: false, error: { kind: "exception" } }.
├── openclaw-executor.ts      420 LOC. `runAgentFromSpawnRequest(api, sr)` is the sole
│                             production entry point — consumed by the spawn-poller.
│                             Passes `authProfileId` + agent provider/model explicitly to
│                             `runEmbeddedPiAgent` (no env fallback). Setup-phase timeout
│                             prevents dispatch ghosts.
├── status-proxy.ts           Thin IPC proxy for `/aof/status` + `/aof/metrics` gateway URLs
│                             (preserves pre-43 URL compatibility — dashboards keep working).
├── dispatch-notification.ts  `mergeDispatchNotificationRecipient(params, id, store)` —
│                             attaches captured dispatcher route + actor envelope as
│                             OpenClawChatDelivery (subscription-delivery.ts schema).
├── tool-invocation-context.ts  OpenClawToolInvocationContextStore — per-session route capture
│                             for notify-on-completion. Stays plugin-side (D-07): captured route
│                             is attached to aof_dispatch params BEFORE the IPC send.
├── subscription-delivery.ts    Phase 44 — Zod schema for the `openclaw-chat` SubscriptionDelivery
│                             kind. Promotes captured-dispatcher fields (sessionKey, sessionId,
│                             target, channel, threadId, dispatcherAgentId, capturedAt, pluginId)
│                             from a plugin-local interface to a typed wire contract. Passthrough
│                             on unknown fields so 999.4 project-wide subscriptions can extend
│                             without a schema break.
├── openclaw-chat-delivery.ts   "openclaw-chat" subscription delivery kind. Runs on the
│                             daemon as an EventLogger callback: on task.transitioned to
│                             a trigger status, filters matching subscriptions and calls
│                             messageTool.send(target, msg, ctx). Dedupe + subscription
│                             status updates live here.
├── chat-delivery-poller.ts     658 LOC. `startChatDeliveryPollerOnce(client, api)` — plugin-side
│                             long-poll loop. Beyond simple chat send (`chat-message-sender`),
│                             it now ALSO injects completion notifications into the dispatcher's
│                             session as a system event AND wakes the agent so the next turn
│                             includes it as turn-context (de5b6bd, Apr 29). Decoupled from
│                             chat-send so a `NoPlatformError` on a subagent/main/cron sessionKey
│                             no longer suppresses the wake. Branches by heartbeat capability:
│                             agents with `heartbeat.every` get `enqueueSystemEvent +
│                             requestHeartbeatNow`; agents without fall back to
│                             `runtime.agent.runEmbeddedPiAgent` (resume-by-default into the
│                             agent's main session). Ephemeral session keys
│                             (`agent:X:cron:UUID`, `agent:X:subagent:UUID`) are redirected to
│                             `agent:X:<mainKey>` so wakes land in the agent's ongoing inbox.
│                             In-flight dedup via `Set<sessionKey>` to absorb recovery-replay storms.
├── chat-message-sender.ts      sendChatDelivery(api, req): parses sessionKey (or uses
│                             delivery.channel + target) and dispatches to the matching
│                             api.runtime.channel.<platform>.sendMessage<Platform>.
│                             Telegram honors threadId; other platforms forward target+text.
├── matrix-notifier.ts          MatrixMessageTool + ChatDeliveryContext interface. The
│                             daemon's queue-backed tool implements this to bridge the
│                             notifier onto ChatDeliveryQueue.enqueueAndAwait().
├── executor.ts, permissions.ts, types.ts  unchanged leaf files (types.ts now exports
│                             OpenClawSystemRuntime + extended OpenClawAgentRuntime.session for
│                             system-event injection paths).
```

### Plugin services & registrationMode guard (2026-04-28)

Pre-fix, `registerAofPlugin` called `startSpawnPollerOnce` and `startChatDeliveryPollerOnce` directly during `register()`. OpenClaw invokes `register()` **in every Node process that loads the plugin** — gateway main + each per-session worker. That meant every worker opened its own pair of long-poll handles on the daemon socket and the loop kept the worker alive forever (11 alive plugin-loaded PIDs observed at audit time on 2026-04-28: 1 gateway + 10 worker zombies). Post-fix:

- **`registrationMode` guard:** OpenClaw's plugin registry only attaches `registerService`, `registerTool`, `registerHook`, `registerHttpRoute`, etc. when `registrationMode === "full"`. Other modes (`setup-only`, `setup-runtime`, `cli-metadata`) omit them and would TypeError. `register()` early-returns in non-`"full"` modes. `undefined` is treated as `"full"` for back-compat.
- **Plugin-service registration:** spawn-poller and chat-delivery-poller are wrapped as `api.registerService({ id, start, stop })`. OpenClaw's `startPluginServices` runs only in the gateway main process exactly once during server startup — workers never invoke it. Confines poller startup to the one process that owns the dispatch bridge and gives a clean shutdown stop hook.
- **Module-scope gates retained as defense-in-depth** against same-process re-register (config reload / hot-swap).
- **Typed `on()` hook:** `<K extends PluginHookName>(hookName: K, handler, opts?)`. PluginHookName mirrors all 29 canonical OpenClaw hooks so typos fail at compile time.

### Chat-delivery pipeline

The "notify the originating session on task completion" feature crosses process boundaries (EventLogger lives in the daemon; session-send lives in the plugin). Mirrors the spawn-poller inversion:

1. Agent calls `aof_dispatch`. `mergeDispatchNotificationRecipient` (in `dispatch-notification.ts`) attaches an `openclaw-chat` `OpenClawChatDelivery` (sessionKey, sessionId, target, channel, threadId, dispatcherAgentId, capturedAt) to `notifyOnCompletion` using the plugin-local invocation-context store.
2. Daemon creates a subscription with that delivery payload via `project-tools.ts:aofDispatch`.
3. Task transitions to a trigger status (`blocked|review|done|cancelled|deadletter`). `EventLogger.log` fires the `OpenClawChatDeliveryNotifier` callback wired in `startAofDaemon` (uses `daemon/resolve-store-for-task.ts` to find the owning project store from a bare `taskId`).
4. The notifier calls `messageTool.send(target, renderedMsg, ctx)` on the daemon-side `QueueBackedMessageTool`, which enqueues a `ChatDeliveryRequest` onto `ChatDeliveryQueue` and returns a promise pending plugin ACK.
5. Plugin's `chat-delivery-poller` claims the request via long-poll. **Two independent paths run from here** (decoupled in de5b6bd to keep the wake load-bearing even when chat-send legitimately fails):
   - **Chat-send (audit channel):** `chat-message-sender` dispatches to the matching OpenClaw outbound channel. May fail with `NoPlatformError` on `subagent/main/cron` sessionKeys — non-fatal for the wake path.
   - **System-event injection (orchestrator resume):** push the completion as a system event into the dispatcher's session AND wake the agent so its next turn carries it as turn-context. Ephemeral session keys (`agent:X:cron:UUID`, `agent:X:subagent:UUID`) are redirected to `agent:X:<mainKey>` for wake purposes only (chat keeps the original key). Wake mechanism branches on heartbeat capability: heartbeat-enabled agents get `enqueueSystemEvent + requestHeartbeatNow`; heartbeat-disabled agents fall back to `runtime.agent.runEmbeddedPiAgent` (resume-by-default into the agent's existing main session via `runtime.agent.session.{resolveStorePath, loadSessionStore, resolveSessionFilePath}`). In-flight dedup via `Set<sessionKey>` collapses recovery-replay storms. Embedded-run wakes prefix prompts with `[AOF wake notification — informational. Reply NO_REPLY if this doesn't affect your active work.]` so agents recognize them as informational rather than directives.
6. Plugin POSTs `/v1/deliveries/{id}/result`. Daemon's `ChatDeliveryQueue.deliverResult` resolves/rejects the awaiting promise.
7. Notifier updates the subscription: `notifiedStatuses += toStatus`; for terminal statuses, `status = "delivered"` + `deliveredAt`. On failure, `deliveryAttempts++` + `failureReason`.

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

All task mutations go through `ITaskStore`. Never call `serializeTask` + `writeFileAtomic` directly. Tasks live in `tasks/<status>/TASK-NNN-<nanoid>.md` and physically move on status transitions.

Post-43, `PermissionAwareTaskStore` wraps **daemon-side**: `src/ipc/store-resolver.ts::buildDaemonResolveStore` loads the org chart once (cached) and returns a per-actor, per-project permission-aware store. Plugin no longer loads org charts.

**Task ID minting (2026-04-25, fbcdda8):** ID format is `TASK-YYYY-MM-DD-<nanoid8>` — the legacy per-store sequential counter (`-001`, `-002`, …) caused cross-store collisions because two stores writing on the same day could each mint `TASK-2026-04-26-001`. Production observation: `TASK-2026-04-26-001` was minted twice on the same day across the unscoped vault and a project-scoped store. Nanoid is collision-free across stores.

**Atomic transitions (2026-04-25, Phase 46-01):** `ITaskStore.transition(...)` accepts a `metadataPatch` field so callers can stamp metadata + rename in a single atomic operation. `transitionToDeadletter` was collapsed to one `store.transition` call to eliminate the stamp-but-not-renamed crash window.

**Startup reconciliation (2026-04-25, Phase 46-02):** `FilesystemTaskStore.init()` runs a reconciliation sweep that detects orphaned in-progress tasks (lease holder gone) and resets them, closing the daemon-crash-mid-dispatch window where the next stale-heartbeat tick would otherwise be the first actor to notice.

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

Implementations:
  PluginBridgeAdapter (primary)   — enqueues SpawnRequest onto SpawnQueue, awaits
                                     deliverResult() via POST /v1/spawns/{id}/result
                                     callback keyed by server-generated spawnId.
  StandaloneAdapter   (fallback)  — HTTP POST to external OpenClaw gateway.
  SelectingAdapter                — thin selector: PluginRegistry.hasActivePlugin()
                                     picks primary vs fallback; in plugin-bridge
                                     mode with no plugin attached returns the D-12
                                     "no-plugin-attached" sentinel.
  MockAdapter                     — configurable test double (auto-complete, fail modes).

Plugin-side, the spawn-poller calls `runAgentFromSpawnRequest(api, sr)` directly —
not via a `GatewayAdapter` instance. The adapter interface is daemon-side only.
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

### Phase 46 — daemon state freshness (Tier A bug fixes)

A cluster of fixes for dispatch ghosts and silently-stuck tasks observed in the 2026-04-26 incident batch:

- **Atomic `transitionToDeadletter`** (46-01, BUG-046a) — `dispatch/lifecycle-handlers.ts` collapses metadata stamp + status rename into a single `store.transition({ metadataPatch })` call. Prevents the half-stamped state where a crash between stamp and rename leaves the task with deadletter metadata but a non-deadletter on-disk status. `TransitionOpts.metadataPatch` is the new store-side hook.
- **Startup reconciliation** (46-02) — `FilesystemTaskStore.init()` now sweeps for in-progress tasks whose lease holders no longer exist and reconciles them on startup, closing a window where a daemon crash mid-dispatch left tasks in `running/` with a dead lease until the next stale-heartbeat sweep.
- **Project rediscovery on every poll** (46-03, BUG-046b) — `AOFService.pollAllProjects` re-runs `discoverProjects()` each tick instead of caching at init. New projects created post-startup now get scheduled without restarting the daemon.
- **Bounded log rotation** (46-04, BUG-046c) — Pino transport switched to `pino-roll` worker (size + time bounds) instead of an unbounded `fd:2` destination. `pino-roll` is skipped under `vitest` env (worker-thread incompatibility). See `logging/index.ts`.
- **Empty routing rejected at `aof_dispatch`** (46-05, BUG-046d) — `tools/project-tools.ts` requires non-empty routing; absent routing now defaults from project owner instead of silently dispatching with no target. RED regression in `tools/__tests__/bug-046d-routing-required.test.ts`.
- **Plugin-side actor fallback** (46-06, BUG-046e) — daemon `/v1/tool/invoke` injects `envelope.actor` into `inner.data` so plugin-side tool handlers see the actor regardless of how the request was constructed; plugin defends in depth by reading `captured.actor` if both arrive empty.

### Phase 999.3 — heartbeat-handler precondition guard

`recovery/heartbeat-handler.ts::handleStaleHeartbeat` now guards against two races: (a) the task's status changed since the stale-heartbeat scan kicked off, (b) the lease was reassigned to a different holder mid-scan. Pre-fix, both could double-requeue or strand the task. Per-precondition coverage in `recovery/__tests__/`.

### Permanent-error classification (2026-04-28)

`dispatch/handleRunComplete` now invokes `classifySpawnError` so OpenClaw's `Agent error: exception: No credentials found for profile "openai:default"` (and similar credential failures) is tagged `errorClass = "permanent"` and deadlettered on first failure rather than cycling `blocked → ready` until retry exhaustion. Avoids burning retry budget on configuration errors that won't self-heal.

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
resolve-store-for-task.ts  Daemon-side `(taskId) => ITaskStore?` resolver. `task.transitioned`
                  events carry only `taskId`; chat-delivery notifier needs to find which
                  project store owns it. Tries the unscoped base store first, then scans
                  `discoverProjects()` lazily, caching `taskId → projectId` indefinitely.
                  Misses are NOT cached (a `ready` task may resolve to `done` with a
                  different on-disk path — store.get() handles that internally).
```

### Artifacts (`src/artifacts/` — Phase 999.4, artifact lifecycle v1)

Long-term archive surface for finished work. Phase boundary between AOF's task state (deleted aggressively) and the user's research/output corpus (preserved indefinitely with index + integrity check).

```
schema.ts          Zod schemas — ArtifactArchiveManifest (per-archive sidecar JSON,
                   schema_version: 1, sha256 + file_count + bytes), ArtifactArchiveIndexRow
                   (SQLite row shape with tags_json + 0/1 boolean), ArtifactArchiveRecord
                   (decoded list output). Three option schemas:
                   archiveArtifactOptions / listArtifactOptions / restoreArtifactOptions.
paths.ts           Resolves archiveRoot + dbPath under AOF_DATA_DIR/artifacts/.
tar.ts             tar+zstd helpers (38 LOC) — pack/unpack with deterministic ordering.
archive-store.ts   SQLite index (better-sqlite3). Insert/list/get rows; tags stored
                   as JSON. 113 LOC.
archive-service.ts Orchestrates: hash → tar → write manifest → insert row → optional
                   destructive prune (move source to trash/). 252 LOC. List + restore
                   complete the surface.
cli/commands/artifacts.ts  `aof artifacts archive|list|restore` (130 LOC). Subcommand
                   under `aof` registered in `cli/program.ts`.
```

Integrity contract: `sha256` of the source tree is computed pre-archive and verified on restore. The optional `pruneOriginalToTrash` flag moves the original into `~/.aof/data/artifacts/trash/` rather than deleting outright (recoverable). User-facing guide in `docs/guide/artifact-lifecycle.md`.

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

Subscription-delivery subsystem that routes task state changes back to the originating chat session and (for orchestrator-resume) back into the dispatcher agent's session as a system event + wake. Captured plugin-side, emitted daemon-side as a typed `SubscriptionDelivery` (`openclaw-chat` kind, schema in `openclaw/subscription-delivery.ts`) on task status transitions (`blocked|review|done|cancelled|deadletter`). All OpenClaw-specific idioms stay inside `src/openclaw/`. Full pipeline narrative under *Thin-plugin module → Chat-delivery pipeline*.

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
| `store/task-store.ts` | 784 | Core store, grew with reconciliation + metadataPatch + nanoid id |
| `openclaw/chat-delivery-poller.ts` | 658 | Chat send + system-event injection + embedded-run wake |
| `cli/commands/memory.ts` | 607 | CLI command module, many subcommands |
| `cli/commands/daemon.ts` | 599 | CLI command module |
| `cli/commands/setup.ts` | 589 | Interactive setup wizard + migration registry |
| `dispatch/dag-evaluator.ts` | 588 | Complex DAG state machine |
| `service/aof-service.ts` | 586 | AOFService orchestration (daemon-only post-43) |
| `openclaw/openclaw-executor.ts` | 420 | runAgentFromSpawnRequest + prepareEmbeddedRun + executeEmbeddedRun + explicit auth/provider/model |
| `protocol/router.ts` | 550 | 8 handler methods, could extract |
| `schemas/workflow-dag.ts` | 538 | Complex schema + validation |
| `dispatch/scheduler.ts` | 531 | Core scheduler, already extracted helpers |
| `packaging/wizard.ts` | 493 | Install wizard |
| `tools/task-workflow-tools.ts` | 471 | DAG workflow tool surface |
| `org/linter.ts` | 463 | Org chart structural validator |
| `projects/migration.ts` | 462 | Project layout migration helpers |

---

## Noted Issues

1. **`console.*` in `src/tools/task-seeder.ts`** (4 calls) — core module using console instead of structured logging.

2. **`console.warn` in `src/config/registry.ts:195`** — `warnUnknownVars()` uses console.warn. Bootstrap concern (Pino may not be initialized yet), but inconsistent with convention.

3. **Serena can't parse some files** — `events/logger.ts`, `events/notifier.ts`, `views/kanban.ts`, `views/mailbox.ts`, `events/notification-policy/engine.ts` fail Serena's TS parser. They compile and test fine. Use `Read` for those files during navigation.

4. **MCP tool override list is hardcoded** — `registerAofTools()` in `mcp/tools.ts` skips 5 tools by name via an inline array. If a new tool is added to the registry with the same name as an MCP-specific handler, the skip list must be manually updated.

5. **SelectingAdapter per-session sticky routing not implemented** — a spawn that landed on the `PluginBridgeAdapter` but whose plugin has since disconnected will report status via the fallback. Accepted behaviour for this wave; refinement deferred.

6. **OpenClaw plugin reload per session** — the gateway reloads the AOF plugin on every agent session start. Module-scope gates in `daemon-ipc-client.ts` and `spawn-poller.ts` survive reload; the design is "at most one live long-poll per plugin process." If OpenClaw ever changes its plugin lifecycle to spawn fresh processes, those gates stop helping — revisit.
