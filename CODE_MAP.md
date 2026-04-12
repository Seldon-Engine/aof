# AOF Code Map

Agentic Ops Fabric — deterministic orchestration for multi-agent systems.  
TypeScript ESM | Node >= 22 | ~42K LOC source | 269 source files, 244 test files

---

## Execution Modes

AOF has two runtime entry points that converge on the same core:

```
Plugin Mode (OpenClaw gateway)              Standalone Mode (CLI daemon)
src/plugin.ts                               src/daemon/index.ts
  -> registerAofPlugin()                      -> startAofDaemon()
  -> OpenClawAdapter (in-process dispatch)    -> StandaloneAdapter (HTTP dispatch)
  -> AOFService.start()                       -> AOFService.start()
           \                                       /
            +------> poll() -> dispatch pipeline --+
```

These paths never cross. Plugin mode never loads `daemon.ts`; standalone mode never calls `registerAofPlugin`. Both resolve to a `GatewayAdapter` and pass it to `AOFService`.

---

## Module Layering

Lower layers must not import from higher layers. Enforced by `madge --circular`.

```
config/          env vars, paths, Zod-validated singleton
logging/         Pino structured logger factory
schemas/         Zod schemas (source of truth for all types)
store/           Filesystem task persistence (ITaskStore)
events/          JSONL event log, notification policy
projects/        Multi-project manifest, store factory
org/             Org chart loading, validation, linting
permissions/     RBAC decorator (PermissionAwareTaskStore)
dispatch/        Scheduler, executor, assignment, DAG eval
protocol/        Agent message routing (AOF/1 protocol)
context/         Context assembly, budget, steward
memory/          Vector search (HNSW), FTS, hybrid search
tools/           Shared tool registry
views/           Kanban, mailbox (derived from task state)
delegation/      Subtask delegation artifacts
drift/           Org chart <-> gateway drift detection
murmur/          Inter-agent review triggers
recovery/        Run artifacts, heartbeat, resume
trace/           Session trace capture and formatting
metrics/         Prometheus-compatible metric collection
openclaw/        OpenClaw plugin adapter
mcp/             MCP protocol server
service/         AOFService orchestration
daemon/          Daemon lifecycle, health server
packaging/       Installer, updater, wizard, migrations
cli/             Commander.js commands (highest layer)
```

Full layering rules are in `ARCHITECTURE.md`.

---

## Core Patterns

### Config Singleton

All env vars are read in one place. The result is Zod-validated, deep-frozen, and cached.

```
src/config/registry.ts
  getConfig()      -> read env -> Zod parse -> deepFreeze -> cache
  resetConfig(ovr) -> deep-merge overrides with Zod defaults (no env read; test isolation)
```

Usage: `import { getConfig } from '../config/registry.js'`. Never read `process.env` directly elsewhere (one documented exception: `AOF_CALLBACK_DEPTH` cross-process mutation in `dispatch/callback-delivery.ts`).

### Zod-First Schemas

Types are always derived from Zod schemas, never the reverse:

```typescript
// src/schemas/task.ts
export const TaskFrontmatter = z.object({ ... });        // Zod schema (const)
export type TaskFrontmatter = z.infer<typeof TaskFrontmatter>;  // Derived type (type alias)
```

Naming: `const` for the Zod object, `type` (same name) for the inferred type. This dual-export pattern is used throughout `src/schemas/`.

### Structured Logging

```typescript
// Module-level logger creation
const log = createLogger('scheduler');

// Usage — err field triggers Pino's error serializer
log.info({ op: 'poll', taskId }, 'dispatching');
log.error({ err, taskId }, 'spawn failed');
```

JSON output to stderr. CLI user-facing output uses `console.*` (OK in `src/cli/` only).

### Store Abstraction

```
ITaskStore (interface, 20+ methods)
  |
  +-- FilesystemTaskStore (real: Markdown + YAML frontmatter files)
  +-- PermissionAwareTaskStore (decorator: org chart RBAC checks)
  +-- createMockStore() (test: typed vi.fn() stubs, pre-seedable)
```

All task mutations go through `ITaskStore` methods. Never call `serializeTask` + `writeFileAtomic` directly.

Tasks live in `tasks/<status>/TASK-NNN.md` and physically move between directories on status transitions.

### Tool Registry

One handler map, two adapters:

```
src/tools/tool-registry.ts          <- defines { schema, handler, description } per tool
src/mcp/tools.ts                    <- registerAofTools() loops over registry, overrides 5 tools with MCP-specific handlers
src/openclaw/adapter.ts             <- registerAofPlugin() loops over registry for OpenClaw tool registration
```

Tool functions are organized by domain:
- `task-crud-tools.ts` — create, update, edit, cancel
- `task-workflow-tools.ts` — DAG workflow operations
- `project-tools.ts` — project CRUD
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

### Executor Interface

```
GatewayAdapter (interface)
  spawnSession(context, opts)      -> SpawnResult
  getSessionStatus(sessionId)      -> SessionStatus
  forceCompleteSession(sessionId)  -> void

Implementations:
  OpenClawAdapter    — in-process via gateway extensionAPI.runEmbeddedPiAgent()
  StandaloneAdapter  — HTTP POST to external OpenClaw gateway
  MockAdapter        — configurable test double (auto-complete, fail modes)
```

---

## Dispatch Pipeline

The scheduler runs on a timer (default 30s) via `AOFService.pollAllProjects()`:

```
poll(store, config)
  1. store.list('ready')                 -> find dispatchable tasks
  2. buildDispatchActions(tasks, config)  -> produces SchedulerAction[]
     - check deps resolved
     - check lease not active
     - check resource not occupied
     - check throttle limits (per-team, global concurrency)
     - resolve target: routing.agent ?? routing.role ?? routing.team
  3. executeActions(actions, config)      -> per-type handler dispatch
     - "assign"       -> executeAssignAction() -> executor.spawnSession()
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

### Memory (`src/memory/`)

Hybrid search over agent-generated memories:

```
VectorStore        -> SQLite + HNSW index (hnswlib-node) + sqlite-vec fallback
FtsStore           -> SQLite FTS5 for BM25 text search
HybridSearchEngine -> combines vector + BM25 with configurable weights
Reranker           -> optional cross-encoder reranker (@huggingface/transformers)
```

Tiered storage: hot (1.0x boost), warm (0.8x), cold (0.5x).  
Embedding providers: OpenAI, Ollama.  
Chunking, curation policy, warm aggregation, hot promotion.

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
- `migrations.ts` — numbered migration framework (001-005)
- `ejector.ts` — remove AOF cleanly
- `snapshot.ts` — backup/restore
- `channels.ts` — update channel management

---

## Test Infrastructure

```
src/testing/harness.ts      -> createTestHarness(): tmpDir + real store + EventLogger
src/testing/mock-store.ts   -> createMockStore(): typed mock satisfying ITaskStore
src/testing/mock-logger.ts  -> createMockLogger(): vi.fn() Pino stubs
src/testing/task-reader.ts  -> readAllTasks(): parse tasks from disk
src/testing/event-log-reader.ts -> readEventLogEntries(): parse JSONL events
src/testing/metrics-reader.ts   -> getMetricValue(): read prom-client metrics
```

Test tiers:
- **Unit tests** (`src/**/__tests__/*.test.ts`): ~3,017 tests, 10s timeout
- **E2E tests** (`tests/e2e/suites/*.test.ts`): 224 tests, sequential, single fork, 60s timeout
- **Integration tests** (`tests/integration/`): plugin integration tests

Naming convention for regression tests: `bug-NNN-description.test.ts`

---

## Feature Anatomy

A typical feature touches these layers:

```
1. Schema       -> src/schemas/foo.ts           (Zod schema + derived type)
2. Store        -> src/store/task-*.ts           (if task-related persistence)
3. Logic        -> src/dispatch/*.ts or module/  (business logic)
4. Tool         -> src/tools/foo-tools.ts        (handler + schema)
5. Registry     -> src/tools/tool-registry.ts    (register handler)
6. Tests        -> src/module/__tests__/*.test.ts
7. CLI (maybe)  -> src/cli/commands/foo.ts       (Commander.js command)
```

MCP and OpenClaw adapters automatically pick up registry tools. Tools that need adapter-specific behavior get explicit handler overrides in `mcp/tools.ts` or `openclaw/adapter.ts`.

---

## Conventions Quick Reference

| Area | Convention |
|------|-----------|
| Config | `getConfig()` from `config/registry.ts`. No `process.env` elsewhere. |
| Logging | `createLogger('component')`. No `console.*` in core modules. |
| Schemas | Zod source of truth. `z.infer<>` for types. |
| Store | `ITaskStore` methods only. No direct serialize+write. |
| Tools | Register in `tool-registry.ts`. Domain-organized handler files. |
| Tests | Colocated `__tests__/`. Use `createTestHarness()` or `createMockStore()`. |
| Imports | `.js` extension in import paths (ESM). |
| Types | `I` prefix for store interfaces. PascalCase types. camelCase functions. |
| Cycles | Extract shared types to `types.ts` leaf files. Verify with `madge --circular`. |
| Barrels | `index.ts` must be pure re-exports, no function definitions. |

---

## Largest Files (potential extraction candidates)

| File | Lines | Notes |
|------|-------|-------|
| `cli/commands/memory.ts` | 607 | CLI command module, many subcommands |
| `cli/commands/daemon.ts` | 599 | CLI command module |
| `dispatch/dag-evaluator.ts` | 588 | Complex DAG state machine |
| `cli/commands/setup.ts` | 561 | Interactive setup wizard |
| `protocol/router.ts` | 550 | 8 handler methods, could extract |
| `schemas/workflow-dag.ts` | 538 | Complex schema + validation |
| `store/task-store.ts` | 533 | Core store, already extracted helpers |
| `dispatch/scheduler.ts` | 531 | Core scheduler, already extracted helpers |

---

## Noted Issues

1. **`console.*` in `src/tools/task-seeder.ts`** (4 calls) — core module using console instead of structured logging.

2. **`console.warn` in `src/config/registry.ts:195`** — `warnUnknownVars()` uses console.warn. Bootstrap concern (Pino may not be initialized yet), but inconsistent with convention.

3. **Serena can't parse some files** — `events/logger.ts`, `events/notifier.ts`, `views/kanban.ts`, `views/mailbox.ts`, `events/notification-policy/engine.ts` fail Serena's TS parser. They compile and test fine. May indicate edge-case syntax patterns worth investigating if Serena is relied on heavily.

4. **MCP tool override list is hardcoded** — `registerAofTools()` in `mcp/tools.ts` skips 5 tools by name via an inline array. If a new tool is added to the registry with the same name as an MCP-specific handler, the skip list must be manually updated.
