# Architecture

**Analysis Date:** 2026-03-12

## Pattern Overview

**Overall:** Layered service architecture with filesystem-backed persistence, dual entry points (CLI + MCP server), and a deterministic scheduler/dispatch loop.

**Key Characteristics:**
- Task state is canonical on the filesystem (Markdown + YAML frontmatter in `tasks/<status>/` directories)
- Views (Kanban, Mailbox) are derived from filesystem state, never mutated directly
- Scheduler is deterministic — no LLM calls in the dispatch loop
- Dual execution model: CLI commands for humans, MCP tools for AI agents
- Plugin architecture for OpenClaw integration (registers tools + services)
- DAG-based workflow system with hop-by-hop evaluation (replaced legacy gate workflows)

## Layers

**Schemas (bottom layer):**
- Purpose: Zod schemas defining all data types — tasks, org charts, events, protocols, workflows
- Location: `src/schemas/`
- Contains: Pure data validation, no I/O, no side effects
- Depends on: Nothing external (clean leaf dependency)
- Used by: Every other module
- Key files: `src/schemas/task.ts`, `src/schemas/workflow-dag.ts`, `src/schemas/org-chart.ts`, `src/schemas/protocol.ts`, `src/schemas/project.ts`
- Barrel: `src/schemas/index.ts` — re-exports all schemas

**Config:**
- Purpose: Path resolution and config read/write
- Location: `src/config/`
- Contains: Pure path functions (`paths.ts`), config manager (`manager.ts`)
- Depends on: `src/schemas/`, `src/org/linter.js` (LAYERING CONCERN)
- Used by: CLI, daemon, MCP, dispatch
- Key files: `src/config/paths.ts` (all well-known filesystem paths), `src/config/manager.ts` (org chart config CRUD)

**Store (persistence):**
- Purpose: Task CRUD, leases, subscriptions, task file parsing/serialization
- Location: `src/store/`
- Contains: `ITaskStore` interface, `FilesystemTaskStore` implementation, lease management, task parser
- Depends on: `src/schemas/`, `src/events/logger.js`, `src/migration/`
- Used by: dispatch, protocol, service, CLI, MCP, tools, context, views, memory
- Key files: `src/store/interfaces.ts` (44 cross-module imports — most imported file in codebase), `src/store/task-store.ts` (575 lines)

**Events:**
- Purpose: Event logging and notification dispatch
- Location: `src/events/`
- Contains: `EventLogger`, `NotificationService`, notification policy engine with rules/watcher
- Depends on: `src/schemas/event.js`
- Used by: dispatch, service, CLI, store, tools, protocol, trace
- Barrel: `src/events/index.ts`

**Dispatch (orchestration core — largest module):**
- Purpose: Scheduler loop, task assignment, DAG/gate evaluation, SLA checking, escalation, callbacks
- Location: `src/dispatch/`
- Contains: 26 files, ~6800 LOC total
- Depends on: store, schemas, events, config, protocol (CIRCULAR), murmur, recovery, trace
- Used by: service, protocol (CIRCULAR), MCP, tools, CLI, openclaw
- Key files: `src/dispatch/scheduler.ts` (585 lines, 32 imports), `src/dispatch/dag-evaluator.ts` (588 lines), `src/dispatch/assign-executor.ts` (544 lines), `src/dispatch/escalation.ts` (493 lines)
- Barrel: `src/dispatch/index.ts` — exports scheduler, executor types, evaluators, condition evaluator

**Protocol:**
- Purpose: Message routing for agent-to-framework communication (status updates, completions, handoffs)
- Location: `src/protocol/`
- Contains: Protocol router, parsers, formatters, task locks, completion utils
- Depends on: store, schemas, events, dispatch (CIRCULAR), delegation, recovery
- Used by: service, MCP
- Key files: `src/protocol/router.ts` (549 lines, 24 imports)

**Service:**
- Purpose: High-level service orchestrator — wires store, scheduler, protocol, metrics
- Location: `src/service/`
- Contains: `AOFService` class with start/stop lifecycle, multi-project support
- Depends on: store, dispatch, protocol, events, metrics, projects
- Used by: daemon, gateway, openclaw
- Key file: `src/service/aof-service.ts` (494 lines)

**MCP (AI agent interface):**
- Purpose: MCP server exposing AOF tools and resources to AI agents
- Location: `src/mcp/`
- Contains: Tool registrations, resource providers, subscription management
- Depends on: dispatch, tools, store, schemas, events, config, org, projects, views
- Hidden dependency: dynamically imports `src/cli/project-utils.js` at runtime
- Key file: `src/mcp/tools.ts` (781 lines — largest non-test file in codebase)
- Barrel: `src/mcp/index.ts`

**CLI (human interface):**
- Purpose: Commander-based CLI commands
- Location: `src/cli/`
- Contains: Command definitions, init/setup wizards, project utilities
- Depends on: Nearly everything — store, dispatch, schemas, events, config, projects, packaging, daemon, memory, drift, trace, metrics, recovery, org
- Entry: `src/cli/index.ts` -> `src/cli/program.ts`
- Key files: `src/cli/commands/memory.ts` (605 lines), `src/cli/commands/daemon.ts` (599 lines), `src/cli/commands/setup.ts` (435 lines)

**Tools (shared tool implementations):**
- Purpose: Tool functions shared between MCP and CLI
- Location: `src/tools/`
- Contains: Task CRUD tools, query tools, workflow tools, context tools, task linter, seeder
- Depends on: store, schemas, events, context, dispatch
- Used by: MCP (`src/mcp/tools.ts`), CLI
- Key file: `src/tools/aof-tools.ts` (re-export hub delegating to domain-specific modules)

**Context:**
- Purpose: Context assembly for agent dispatch — bundles task info, org chart, skills
- Location: `src/context/`
- Contains: Assembler, resolvers, registry, budget, steward, handoff, skills, manifest
- Depends on: store, schemas, events, metrics
- Used by: dispatch (via `src/dispatch/aof-dispatch.ts`), tools
- Barrel: `src/context/index.ts` — `export *` from all submodules

**Projects:**
- Purpose: Multi-project support — discovery, resolution, bootstrapping, migration
- Location: `src/projects/`
- Contains: Registry, resolver, bootstrap, lint, migration, manifest builder
- Depends on: schemas, events
- Used by: service, CLI, MCP
- Barrel: `src/projects/index.ts`

**Memory:**
- Purpose: Vector memory system with embeddings, search, tiered storage
- Location: `src/memory/`
- Contains: Vector store, FTS, HNSW index, chunking, embedding providers, project memory
- Depends on: `src/openclaw/types.js`, `src/projects/`, `src/schemas/`, `src/store/`
- Self-contained subsystem with own internal layering: `store/`, `tools/`, `embeddings/`, `chunking/`, `import/`, `adapters/`
- Key file: `src/memory/index.ts` (~280 lines — contains both barrel exports AND module registration logic)

**OpenClaw (plugin adapter):**
- Purpose: Integration adapter for OpenClaw platform
- Location: `src/openclaw/`
- Contains: Plugin adapter, executor implementation, Matrix notifier, types
- Depends on: dispatch/executor, gateway, store, service
- Key file: `src/openclaw/adapter.ts` (616 lines)

**Supporting modules:**
- `src/daemon/` — Standalone daemon entry point, health server, service file generation
- `src/recovery/` — Run artifacts (heartbeats, results), crash recovery
- `src/delegation/` — Handoff artifact writing
- `src/drift/` — Org chart drift detection
- `src/murmur/` — Asynchronous review triggers (state manager, trigger evaluator, context builder, cleanup)
- `src/trace/` — Session trace writing, reading, formatting
- `src/metrics/` — Metrics collection and export
- `src/migration/` — Gate-to-DAG schema migration
- `src/packaging/` — Installer, updater, ejector, wizard, snapshot, channels, migrations
- `src/permissions/` — Task permission checking against org chart
- `src/plugins/watchdog/` — Watchdog plugin
- `src/views/` — Kanban, mailbox, watcher views (derived from task state)
- `src/adapters/` — `ConsoleNotifier` (notification adapter for standalone mode)
- `src/integration/` — Integration tests directory
- `src/commands/` — Standalone command implementations (org, memory, drift)
- `src/testing/` — Test utilities (task reader, metrics reader)

## Data Flow

**Task Dispatch (scheduler poll):**

1. `AOFService.start()` (`src/service/aof-service.ts`) begins poll loop at configurable interval
2. `poll()` (`src/dispatch/scheduler.ts`) scans all projects, loads tasks via `ITaskStore`
3. `buildDispatchActions()` (`src/dispatch/task-dispatcher.ts`) determines assign/expire/promote actions
4. `executeActions()` (`src/dispatch/action-executor.ts`) processes each action
5. `assignAndDispatch()` (`src/dispatch/assign-executor.ts`) acquires lease, builds context, spawns agent via `GatewayAdapter`
6. Agent communicates back via protocol messages parsed by `ProtocolRouter` (`src/protocol/router.ts`)
7. DAG workflows advance hops via `handleDAGHopCompletion()` (`src/dispatch/dag-transition-handler.ts`)

**Agent Protocol Message:**

1. Agent calls MCP tool (e.g., `aof_task_complete`) or writes protocol envelope
2. `parseProtocolMessage()` (`src/protocol/parsers.ts`) validates envelope against Zod schema
3. `ProtocolRouter.handleMessage()` routes by message type (status_update, completion_report, handoff_request, handoff_ack)
4. Router updates task state via `ITaskStore`, triggers cascading via `cascadeOnCompletion()` / `cascadeOnBlock()` (`src/dispatch/dep-cascader.ts`)
5. For DAG workflows, `handleDAGHopCompletion()` evaluates next hop conditions and dispatches

**State Management:**
- All task state lives on the filesystem in `tasks/<status>/<taskId>.md` files
- Leases are stored in task frontmatter metadata (no external lock service)
- Event log is append-only JSONL in `events/` directory
- Memory is SQLite-backed with HNSW index sidecar files
- Run artifacts stored in `state/runs/<taskId>/` per project
- No in-memory caches survive across poll cycles (stateless design)

## Key Abstractions

**ITaskStore:**
- Purpose: Core persistence interface — all task CRUD goes through this
- Defined: `src/store/interfaces.ts`
- Implementation: `src/store/task-store.ts` (`FilesystemTaskStore`)
- Pattern: Interface + single implementation; interface enables testing with stubs
- CONCERN: Many modules bypass `ITaskStore` by directly calling `serializeTask()` + `writeFileAtomic()` (14 call sites in dispatch, protocol, service)

**GatewayAdapter:**
- Purpose: Agent execution abstraction — spawns and monitors agent sessions
- Defined: `src/dispatch/executor.ts`
- Implementations: `MockAdapter` (testing), `OpenClawExecutor` (`src/openclaw/openclaw-executor.ts`)
- Pattern: Strategy pattern, injected into scheduler and protocol router
- Also defines `TaskContext`, `SpawnResult`, `SessionStatus`, `AgentRunOutcome`

**EventLogger:**
- Purpose: Audit trail and notification trigger
- Defined: `src/events/logger.ts`
- Pattern: Append-only JSONL log with event callbacks for notification integration

**ProtocolRouter:**
- Purpose: Routes agent protocol messages to appropriate handlers
- Defined: `src/protocol/router.ts`
- Pattern: Message type dispatch with dependency injection (`ProtocolRouterDependencies`)

**AOFService:**
- Purpose: Top-level lifecycle orchestrator
- Defined: `src/service/aof-service.ts`
- Pattern: Composition root — wires store, scheduler, protocol, metrics, notifications

## Entry Points

**CLI (`aof`):**
- Location: `src/cli/index.ts` -> `src/cli/program.ts`
- Triggers: User runs `aof <command>`
- Responsibilities: All human-facing operations — task management, setup, config, diagnostics

**Daemon (`aof-daemon`):**
- Location: `src/daemon/index.ts` -> `src/daemon/daemon.ts`
- Triggers: Systemd/launchd service or manual start
- Responsibilities: Runs `AOFService` with poll loop, health server on Unix socket

**Library API:**
- Location: `src/index.ts`
- Triggers: `import` from consuming packages
- Responsibilities: Re-exports schemas, store, service, tools, views, dispatch, protocol, context, delegation, recovery, openclaw, daemon, gateway

**OpenClaw Plugin:**
- Location: `src/openclaw/adapter.ts`
- Triggers: OpenClaw loads the plugin via extension manifest
- Responsibilities: Registers MCP tools, gateway handler, memory module, daemon service

## Error Handling

**Strategy:** Exception-based with Zod validation at boundaries

**Patterns:**
- Zod schemas validate all external input (task files, protocol messages, config files, CLI args)
- `McpError` with typed error codes for MCP tool failures (`src/mcp/tools.ts`)
- Scheduler catches and logs errors per-task, continues processing remaining tasks
- `failure-tracker.ts` (`src/dispatch/failure-tracker.ts`) tracks dispatch failures; transitions to deadletter after configurable threshold
- Protocol router uses structured error responses in protocol envelopes
- Lease expiration prevents zombie task assignments

## Cross-Cutting Concerns

**Logging:** `EventLogger` (`src/events/logger.ts`) for structured audit events; `console.info/warn/error` for operational logs. No structured logging framework.

**Validation:** Zod schemas at ingestion boundaries — task file parse, config load, protocol message parse, CLI input.

**Authentication:** None at the AOF layer — trust model based on filesystem access and agent identity in protocol messages. Auth is handled by OpenClaw platform layer.

**Concurrency:** Filesystem leases (`src/store/lease.ts`) for task assignment; `TaskLockManager` (`src/protocol/task-lock.ts`) for in-flight protocol messages; throttle (`src/dispatch/throttle.ts`) for max concurrent dispatches.

**Path Resolution:** Centralized in `src/config/paths.ts`. All well-known paths (org chart, project manifest, events dir, daemon socket, murmur state, memory DB, run artifacts) resolved through pure functions taking a base directory.

## Architectural Concerns

### 1. Circular Dependency: dispatch <-> protocol

`src/protocol/router.ts` imports from `src/dispatch/dep-cascader.js` and `src/dispatch/dag-transition-handler.js`. Meanwhile, `src/dispatch/scheduler.ts` and `src/dispatch/action-executor.ts` import from `src/protocol/completion-utils.js`.

These modules form a bidirectional dependency. The `completion-utils.ts` file only depends on schemas and could be extracted to a shared location (e.g., `src/schemas/` or a new `src/shared/` module). The dep-cascader and dag-transition-handler could be extracted to a neutral module used by both dispatch and protocol.

### 2. Store Abstraction Bypass (14 call sites)

Multiple modules directly call `serializeTask()` + `writeFileAtomic()` instead of going through `ITaskStore`, meaning the store interface does not control all task mutations:
- `src/dispatch/action-executor.ts` (lines 75, 240)
- `src/dispatch/assign-executor.ts` (lines 133, 259, 356, 453)
- `src/dispatch/dag-transition-handler.ts` (line 160)
- `src/dispatch/escalation.ts` (lines 122, 387)
- `src/dispatch/failure-tracker.ts` (lines 43, 134)
- `src/protocol/router.ts` (line 465)
- `src/service/aof-service.ts` (line 321)

This bypasses any hooks, validation, or event emission that the store provides. New store implementations would miss these writes.

### 3. Config -> Org Upward Import

`src/config/manager.ts` imports `lintOrgChart` from `src/org/linter.js` (line 14). Config is a low-level infrastructure module; org is a higher-level domain module. This creates a dependency inversion — the config layer depends on domain logic for validation.

Fix: Move org chart validation to config layer or inject the linter function.

### 4. MCP -> CLI Hidden Dependency

`src/mcp/shared.ts` dynamically imports `src/cli/project-utils.js` (line 51). MCP and CLI are peer entry points, not in a parent-child relationship. The `createProjectStore()` function should live in `src/projects/` or `src/store/` where both can depend on it.

### 5. Dispatch Module Size (26 files, ~6800 LOC)

`src/dispatch/` is the largest module by far. It handles: scheduling, DAG evaluation, gate evaluation (deprecated), task assignment, escalation, murmur integration, callback delivery, throttling, lease management, failure tracking, DAG transitions, SLA checking, condition evaluation, context building, duration parsing, and action execution.

Candidates for extraction:
- Murmur integration (`murmur-integration.ts`, `murmur-hooks.ts`) -> `src/murmur/`
- Callback delivery (`callback-delivery.ts`) -> `src/events/` or new `src/callbacks/`
- Lease management (`lease-manager.ts`, `throttle.ts`) -> `src/store/`

### 6. mcp/tools.ts God File (781 lines)

`src/mcp/tools.ts` is the largest non-test source file. It contains all MCP tool registrations in a single `registerAofTools()` function with inline Zod schemas, validation, and business logic. This contrasts with the well-factored `src/tools/aof-tools.ts` which properly delegates to domain-specific modules (`project-tools.ts`, `query-tools.ts`, `task-tools.ts`).

### 7. Deprecated Gate Workflow Code Still in Import Paths

Several files carry `@deprecated Since v1.2` markers but remain actively imported and re-exported:
- `src/dispatch/gate-evaluator.ts` — imported by `src/dispatch/scheduler.ts`
- `src/dispatch/gate-context-builder.ts` — imported by `src/dispatch/assign-executor.ts`
- `src/dispatch/gate-conditional.ts` — re-exported from `src/dispatch/index.ts`
- `src/schemas/gate.ts` — imported by dispatch, re-exported from `src/schemas/index.ts`
- `src/schemas/workflow.ts` — imported by dispatch scheduler and escalation

### 8. Direct Filesystem I/O in Business Logic

The dispatch module makes 15+ direct `readFile`/`writeFileAtomic` calls. Business logic (evaluation, escalation, assignment) is tightly coupled to filesystem I/O rather than operating through store abstractions. For example:
- `src/dispatch/assign-executor.ts` reads project manifest YAML directly (line 43)
- `src/dispatch/escalation.ts` reads project manifest YAML directly (line 40)
- `src/dispatch/scheduler.ts` reads project manifest YAML directly (line 220)

These should go through a project config reader abstraction.

### 9. memory/index.ts Dual Responsibility

`src/memory/index.ts` (~280 lines) serves as both a barrel export AND contains the full `registerMemoryModule()` function with substantial initialization logic (DB setup, HNSW rebuild, tool registration, project-aware wrappers). This should be split into `src/memory/index.ts` (barrel) and `src/memory/register.ts` (registration logic).

### 10. process.env Access Scattered Across Modules

Direct `process.env` access appears in 11 files outside config:
- `src/config/paths.ts` (AOF_DATA_DIR)
- `src/projects/resolver.ts` (AOF_ROOT)
- `src/dispatch/callback-delivery.ts`
- `src/mcp/shared.ts` (AOF_CALLBACK_DEPTH)
- `src/mcp/server.ts`
- `src/memory/index.ts` (OPENAI_API_KEY)
- `src/openclaw/openclaw-executor.ts`
- `src/cli/program.ts`
- `src/cli/commands/memory.ts`
- `src/daemon/standalone-adapter.ts`
- `src/daemon/index.ts`

Environment variable reads should be consolidated in `src/config/`.

---

*Architecture analysis: 2026-03-12*
