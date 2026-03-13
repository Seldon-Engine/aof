# Phase 38: Code Refactoring - Research

**Researched:** 2026-03-12
**Domain:** TypeScript refactoring — god function decomposition, handler unification, deduplication
**Confidence:** HIGH

## Summary

Phase 38 is a pure refactoring phase targeting four god files totaling 2,236 lines: `assign-executor.ts` (522 LOC), `action-executor.ts` (425 LOC), `mcp/tools.ts` (670 LOC), and `openclaw/adapter.ts` (619 LOC). The work decomposes into four independent workstreams: (1) extracting helpers from assign-executor and action-executor, (2) deduplicating callback/trace patterns in assign-executor, (3) unifying tool registration between MCP and OpenClaw via a shared handler map in `src/tools/`, and (4) splitting the MCP tools.ts god file.

The codebase already has strong established patterns to follow: `src/tools/` already contains domain-split modules (project-tools.ts, query-tools.ts, task-tools.ts) with the barrel re-export pattern in aof-tools.ts. The Pino structured logging from Phase 37 uses `createLogger('component')` consistently. Existing tests in `dispatch/__tests__/` provide integration coverage that must remain green.

**Primary recommendation:** Execute in 3-4 plans: (1) assign-executor decomposition + callback/trace dedup (REF-01, REF-04, REF-05), (2) action-executor switch decomposition (REF-02), (3) tool registration unification + MCP split + OpenClaw permissions HOF (REF-03, REF-07, REF-08). REF-06 is N/A.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Extract helpers to **sibling modules** (not same-file): assign-helpers.ts, action-handlers grouped by concern
- executeActions() switch cases grouped into 3-4 handler files by domain (e.g., lifecycle-handlers.ts for assign/expire/promote, dep-handlers.ts for block/unblock/cascade)
- Orchestrator functions (executeAssignAction, executeActions) target **~80 lines max** — orchestration + inline error handling/logging OK, but all business logic in named calls
- Each new sibling module gets its **own test file**. Existing tests remain for integration-level coverage of orchestrators
- **Shared handler map** in `src/tools/` — a tool-registry.ts exports `{toolName: {schema, handler}}` map
- Map includes both **Zod schemas and handler functions** — eliminates schema drift between MCP and OpenClaw
- Handler functions are **framework-agnostic** — return plain results or throw standard errors
- Schemas **co-located per handler** — each tool module (task-tools.ts, project-tools.ts) exports schemas alongside handlers
- Both MCP tools.ts and OpenClaw adapter.ts **loop over the handler map** to register tools
- mcp/tools.ts becomes **thin registration only** (~50 lines)
- Inline Zod schemas move to src/tools/ co-located with their handlers
- Handler functions move to src/tools/ as framework-agnostic implementations
- New files in **dispatch/ module**: dispatch/callback-helpers.ts, dispatch/trace-helpers.ts
- Both helpers use **swallow + log** pattern — catch errors internally and log at warn level
- deliverAllCallbacksSafely() and captureTraceSafely() as the canonical function names
- withPermissions() HOF in a **separate module**: openclaw/permissions.ts
- Adapter loops over the handler map, wrapping each handler with withPermissions() automatically
- **REF-06 marked N/A** — gate-to-DAG migration deduplication fully resolved by DEAD-04 in Phase 34

### Claude's Discretion
- Exact grouping of action handler files (which action types go in which file)
- Internal structure of the tool-registry map (flat vs nested)
- How MCP-specific content formatting is handled in the thin wrapper
- Naming of grouped handler files within dispatch/

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| REF-01 | executeAssignAction() decomposed — onRunComplete callback, trace capture, callback delivery extracted into named helpers | assign-executor.ts analysis: onRunComplete is a 163-line inline callback (lines 157-320) with duplicated trace+callback blocks. Extract to sibling assign-helpers.ts |
| REF-02 | executeActions() 415-line switch decomposed — each case extracted into named handler function | action-executor.ts analysis: 10 switch cases, largest is expire_lease (~90 lines). Group into 3-4 handler files by domain |
| REF-03 | Tool registration unified — shared handler functions between OpenClaw adapter and MCP server | MCP tools.ts has 15 Zod schemas + 15 handlers; OpenClaw adapter.ts has 11 JSON Schema registrations + 11 execute blocks with identical logic. Both call same aof-tools.ts functions |
| REF-04 | Callback delivery code deduplicated in assign-executor.ts — single deliverAllCallbacksSafely() helper | 9 callback delivery calls (deliverCallbacks + deliverAllGranularityCallbacks) across 2 code paths in onRunComplete, identical setup pattern with SubscriptionStore |
| REF-05 | Trace capture code deduplicated in assign-executor.ts — single captureTraceSafely() helper | 3 captureTrace calls with identical try/catch/warn pattern. Extract to dispatch/trace-helpers.ts |
| REF-06 | Gate-to-DAG migration check deduplicated | **N/A** — fully resolved by DEAD-04 in Phase 34 (code removed entirely). Note for audit trail only |
| REF-07 | OpenClaw adapter withPermissions() HOF replaces 10 copy-pasted execute blocks | 20 `(params as any)` casts in adapter.ts. Each execute block repeats: extract actor, extract project, resolveProjectStore, getStoreForActor, call tool, wrapResult |
| REF-08 | MCP tools.ts god file split — inline schemas moved to shared location | 670-line file with 15 inline Zod schemas. Handlers already exist as exported functions — schemas need to move to co-locate with them in src/tools/ |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | (project version) | Language | Already in use |
| Vitest | ^3.0.0 | Test framework | Already configured, used across all test files |
| Zod | (project version) | Schema validation | Already used for all MCP schemas, extend to tool registry |
| Pino | (project version) | Structured logging | Phase 37 — all new helpers use `createLogger(component)` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| write-file-atomic | (project version) | Atomic file writes | Already used in assign-executor.ts — stays in extracted helpers |

### Alternatives Considered
None — this is pure refactoring using existing project dependencies.

**Installation:** No new dependencies required.

## Architecture Patterns

### Recommended Project Structure (new/modified files)
```
src/
├── dispatch/
│   ├── assign-executor.ts      # Slimmed orchestrator (~80 LOC)
│   ├── assign-helpers.ts       # NEW: onRunComplete, metadata helpers
│   ├── callback-helpers.ts     # NEW: deliverAllCallbacksSafely()
│   ├── trace-helpers.ts        # NEW: captureTraceSafely()
│   ├── action-executor.ts      # Slimmed orchestrator (~80 LOC)
│   ├── lifecycle-handlers.ts   # NEW: expire_lease, promote, requeue
│   ├── recovery-handlers.ts    # NEW: stale_heartbeat, deadletter
│   ├── alert-handlers.ts       # NEW: alert, sla_violation, murmur_create_task, block
│   └── __tests__/
│       ├── assign-helpers.test.ts      # NEW
│       ├── callback-helpers.test.ts    # NEW
│       ├── trace-helpers.test.ts       # NEW
│       ├── lifecycle-handlers.test.ts  # NEW
│       ├── recovery-handlers.test.ts   # NEW
│       └── alert-handlers.test.ts      # NEW
├── tools/
│   ├── tool-registry.ts        # NEW: {toolName: {schema, handler, description}} map
│   ├── task-tools.ts           # MODIFIED: export Zod schemas alongside handlers
│   ├── project-tools.ts        # MODIFIED: export Zod schemas alongside handlers
│   ├── query-tools.ts          # MODIFIED: export Zod schemas
│   └── aof-tools.ts            # MODIFIED: re-export registry
├── mcp/
│   └── tools.ts                # SLIMMED: thin registration loop (~50 LOC)
└── openclaw/
    ├── adapter.ts              # SLIMMED: loop over handler map
    └── permissions.ts          # NEW: withPermissions() HOF
```

### Pattern 1: Swallow-and-Log Helpers
**What:** Wrap fallible best-effort operations (callbacks, traces) in a helper that catches internally and logs at warn level
**When to use:** Any fire-and-forget side effect that must never block the main flow
**Example:**
```typescript
// dispatch/trace-helpers.ts
import { createLogger } from "../logging/index.js";
import { captureTrace } from "../trace/trace-writer.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";

const log = createLogger("trace-helpers");

export interface TraceCaptureParams {
  taskId: string;
  sessionId: string;
  agentId: string;
  durationMs: number;
  store: ITaskStore;
  logger: EventLogger;
  debug?: boolean;
}

export async function captureTraceSafely(params: TraceCaptureParams): Promise<void> {
  try {
    await captureTrace({
      taskId: params.taskId,
      sessionId: params.sessionId,
      agentId: params.agentId,
      durationMs: params.durationMs,
      store: params.store,
      logger: params.logger,
      debug: params.debug ?? false,
    });
  } catch (err) {
    log.warn({ err, taskId: params.taskId, op: "traceCapture" }, "trace capture failed (best-effort)");
  }
}
```

### Pattern 2: Shared Handler Map (Tool Registry)
**What:** A flat map of `{toolName: {schema, handler, description}}` that both MCP and OpenClaw consume
**When to use:** Any tool that needs to be registered in multiple adapters
**Example:**
```typescript
// tools/tool-registry.ts
import { z } from "zod";

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  description: string;
  schema: TSchema;
  handler: (ctx: ToolContext, input: z.infer<TSchema>) => Promise<unknown>;
}

export type ToolRegistry = Record<string, ToolDefinition>;

// Import from domain modules
import { taskToolDefinitions } from "./task-tools.js";
import { projectToolDefinitions } from "./project-tools.js";
import { queryToolDefinitions } from "./query-tools.js";

export const toolRegistry: ToolRegistry = {
  ...taskToolDefinitions,
  ...projectToolDefinitions,
  ...queryToolDefinitions,
};
```

### Pattern 3: withPermissions() HOF
**What:** Higher-order function that wraps a tool handler with actor/project extraction and permission-aware store creation
**When to use:** OpenClaw adapter — replaces 10 copy-pasted execute blocks
**Example:**
```typescript
// openclaw/permissions.ts
import type { ITaskStore } from "../store/interfaces.js";

export function withPermissions(
  handler: (store: ITaskStore, params: Record<string, unknown>) => Promise<unknown>,
  resolveProjectStore: (projectId?: string) => ITaskStore,
  getStoreForActor: (actor?: string, baseStore?: ITaskStore) => Promise<ITaskStore>,
) {
  return async (_id: string, params: Record<string, unknown>) => {
    const actor = params.actor as string | undefined;
    const projectId = params.project as string | undefined;
    const projectStore = resolveProjectStore(projectId);
    const permissionStore = await getStoreForActor(actor, projectStore);
    return handler(permissionStore, params);
  };
}
```

### Pattern 4: Action Handler Functions
**What:** Each switch case extracted to a named async function with explicit parameters
**When to use:** action-executor.ts decomposition
**Example:**
```typescript
// dispatch/lifecycle-handlers.ts
import { createLogger } from "../logging/index.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { SchedulerAction } from "./scheduler.js";

const log = createLogger("lifecycle-handlers");

export async function handleExpireLease(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger,
  allTasks: import("../schemas/task.js").Task[],
  config: import("./scheduler.js").SchedulerConfig,
): Promise<{ leasesExpired: number; tasksRequeued: number }> {
  // ... extracted logic from expire_lease case
}
```

### Anti-Patterns to Avoid
- **Circular imports from handler files back to orchestrator:** Handler files must not import from assign-executor.ts or action-executor.ts. Pass dependencies as parameters.
- **Leaking framework types into shared handlers:** tool-registry handlers must not import McpError or OpenClaw types. Return plain objects, throw standard Error subclasses.
- **Over-abstracting the handler map:** Keep it a simple flat Record. No class hierarchies, no middleware chains. The MCP and OpenClaw wrappers handle framework-specific concerns.
- **Breaking existing test imports:** assign-executor.test.ts and other existing tests import from the current file paths. Keep re-exports for backward compatibility if any tests import helpers directly.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Zod-to-JSON-Schema conversion | Manual schema translation | zod-to-json-schema (if needed) or keep dual schemas | OpenClaw uses JSON Schema, MCP uses Zod. The adapter can convert at registration time |
| Test mocking | Custom mock framework | Vitest vi.mock/vi.fn | Already established in project |
| Atomic file writes | Manual tmp+rename | write-file-atomic | Already used throughout codebase |

**Key insight:** The OpenClaw adapter currently uses JSON Schema objects (not Zod) for its `parameters` field. The tool-registry uses Zod. The OpenClaw registration loop will need to either: (a) use `zodToJsonSchema()` at registration time, or (b) maintain the existing JSON Schema objects alongside Zod schemas. Option (a) is cleaner but adds a dependency; option (b) adds no dependency but means dual schemas. **Recommendation:** Check if `zod-to-json-schema` is already in the project. If not, keep the OpenClaw adapter's existing JSON Schema definitions but reference handler functions from the registry. The important unification is the handler functions, not necessarily the schemas.

## Common Pitfalls

### Pitfall 1: Breaking the onRunComplete Closure
**What goes wrong:** The onRunComplete callback in executeAssignAction() closes over `action`, `store`, `logger`, `config`, `correlationId`, and `effectiveConcurrencyLimitRef`. Extracting it naively can lose access to these.
**Why it happens:** The callback is passed to executor.spawnSession() and runs asynchronously after the spawn. It needs all the original context.
**How to avoid:** Create a context object (or pass parameters explicitly) that bundles everything the callback needs. The extracted helper should accept this context as a parameter.
**Warning signs:** Tests fail with "undefined" errors for store/logger/config.

### Pitfall 2: Duplicated SubscriptionStore Construction
**What goes wrong:** The SubscriptionStore is constructed twice in the onRunComplete callback (lines 189-194 and 296-301) with identical logic. When extracting deliverAllCallbacksSafely(), ensure the SubscriptionStore construction is also deduplicated inside the helper.
**Why it happens:** Copy-paste from early-return path vs enforcement path.
**How to avoid:** deliverAllCallbacksSafely() should construct its own SubscriptionStore internally, or accept one as a parameter.

### Pitfall 3: Changing Action Handler Return Types
**What goes wrong:** The executeActions() switch tracks `executed` and `failed` flags per action. Extracted handlers must return compatible flag information.
**Why it happens:** Each case has different semantics — only "assign" sets executed=true.
**How to avoid:** Define a consistent return type like `{ executed: boolean; failed: boolean; leasesExpired?: number; tasksRequeued?: number; tasksPromoted?: number }` for all handlers.

### Pitfall 4: lockManager Wrapping Must Stay in Orchestrator
**What goes wrong:** The expire_lease case wraps its body in `config.lockManager.withLock()`. If extracted naively, the lock wrapping gets lost.
**Why it happens:** The lock is an orthogonal concern that wraps the handler, not part of the handler itself.
**How to avoid:** Keep lock wrapping in the orchestrator's switch statement (or in a thin wrapper). The extracted handler is the "body" that runs inside the lock.

### Pitfall 5: MCP tools.ts Handler Functions Already Exist
**What goes wrong:** Attempting to "extract" handlers that are already exported from mcp/tools.ts (handleAofDispatch, handleAofTaskUpdate, etc.) into src/tools/ when they already have different signatures.
**Why it happens:** MCP handlers accept `AofMcpContext` while src/tools/ functions accept `ToolContext`. These are different types.
**How to avoid:** The shared handler map should use `ToolContext` (from src/tools/aof-tools.ts). MCP tools.ts already calls these via handleAof* wrappers. The handler map should wrap the existing tool functions, not the MCP-specific handleAof* functions.

### Pitfall 6: OpenClaw Adapter Has Tools Not in MCP
**What goes wrong:** The OpenClaw adapter registers `aof_project_add_participant` which has no MCP equivalent. The shared handler map must account for adapter-specific tools.
**Why it happens:** The two adapters evolved independently.
**How to avoid:** The tool-registry can include all tools. MCP registration can filter to only register the subset it supports, or register all. The registry is the superset.

## Code Examples

### Current Duplication: Trace Capture (assign-executor.ts)
```typescript
// Appears 3 times with identical pattern (lines 168-185, 273-292, plus variant)
try {
  const sid = outcome.sessionId;
  const aid = action.agent;
  if (sid && aid) {
    const traceDebug = currentTask?.frontmatter.metadata?.debug === true;
    await captureTrace({
      taskId: action.taskId,
      sessionId: sid,
      agentId: aid,
      durationMs: outcome.durationMs,
      store,
      logger,
      debug: traceDebug,
    });
  }
} catch (err) {
  log.warn({ err, taskId: action.taskId, op: "traceCapture" }, "trace capture failed (best-effort)");
}
```

### Current Duplication: Callback Delivery (assign-executor.ts)
```typescript
// Appears twice with identical setup pattern (lines 188-213, 295-319)
const tasksDir = store.tasksDir;
const taskDirResolver = async (tid: string): Promise<string> => {
  const t = await store.get(tid);
  if (!t) throw new Error(`Task not found: ${tid}`);
  return join(tasksDir, t.frontmatter.status, tid);
};
const subscriptionStore = new SubscriptionStore(taskDirResolver);
const callbackOpts = { taskId: action.taskId, store, subscriptionStore, executor, logger };
try { await deliverCallbacks(callbackOpts); } catch (err) { ... }
try { await deliverAllGranularityCallbacks(callbackOpts); } catch (err) { ... }
```

### Current Duplication: OpenClaw Execute Blocks (adapter.ts)
```typescript
// Repeated 10 times with same pattern (20 `(params as any)` casts)
execute: async (_id: string, params: Record<string, unknown>) => {
  const actor = (params as any).actor;
  const projectId = (params as any).project as string | undefined;
  const projectStore = resolveProjectStore(projectId);
  const permissionStore = await getStoreForActor(actor, projectStore);
  const result = await aofSomeFunction({ store: permissionStore, logger, projectId }, params as any);
  return wrapResult(result);
},
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Console.log everywhere | Pino structured logging | Phase 37 (just completed) | All new helpers use `createLogger()` |
| Scattered process.env reads | Config registry (Zod-based) | Phase 36 | Helpers should use config registry where applicable |
| Gate system | DAG workflows | Phase 17-20 | REF-06 is N/A due to gate removal in Phase 34 |

## Open Questions

1. **Zod-to-JSON-Schema for OpenClaw**
   - What we know: MCP uses Zod schemas, OpenClaw uses JSON Schema objects. The tool registry will use Zod.
   - What's unclear: Whether to add `zod-to-json-schema` dependency or maintain dual schemas for OpenClaw.
   - Recommendation: Check if `zod-to-json-schema` is already a transitive dependency. If not, keep OpenClaw's JSON Schema objects and share only handler functions (not schemas) via the registry. The primary goal is eliminating duplicated handler logic and `(params as any)` casts, not necessarily schema unification. The planner should decide based on dependency policy.

2. **aof_board and aof_project_add_participant handlers**
   - What we know: `aof_board` in MCP takes a `buildBoard` function parameter (not a standard tool handler). `aof_project_add_participant` exists only in OpenClaw.
   - What's unclear: Whether these non-standard tools should go in the registry or stay as adapter-specific registrations.
   - Recommendation: Keep these as adapter-specific. The registry covers the 10 tools that are shared between both adapters. Board and participant tools are registered directly in their respective adapters.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^3.0.0 |
| Config file | vitest.config.ts (root) |
| Quick run command | `npx vitest run src/dispatch/__tests__/assign-executor.test.ts --reporter=verbose` |
| Full suite command | `npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REF-01 | executeAssignAction decomposed, helpers testable | unit | `npx vitest run src/dispatch/__tests__/assign-helpers.test.ts -x` | Wave 0 |
| REF-02 | executeActions switch decomposed | unit | `npx vitest run src/dispatch/__tests__/lifecycle-handlers.test.ts -x` | Wave 0 |
| REF-03 | Tool registration unified via handler map | unit | `npx vitest run src/tools/__tests__/tool-registry.test.ts -x` | Wave 0 |
| REF-04 | Callback delivery deduplicated | unit | `npx vitest run src/dispatch/__tests__/callback-helpers.test.ts -x` | Wave 0 |
| REF-05 | Trace capture deduplicated | unit | `npx vitest run src/dispatch/__tests__/trace-helpers.test.ts -x` | Wave 0 |
| REF-06 | N/A | N/A | N/A | N/A |
| REF-07 | withPermissions HOF replaces copy-paste | unit | `npx vitest run src/openclaw/__tests__/permissions.test.ts -x` | Wave 0 |
| REF-08 | MCP tools.ts slimmed to registration loop | integration | `npx vitest run src/mcp/__tests__/ -x` | Existing tests cover |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose` (full unit suite)
- **Per wave merge:** `npm test` (full suite with lock)
- **Phase gate:** Full suite green + existing integration tests pass

### Wave 0 Gaps
- [ ] `src/dispatch/__tests__/assign-helpers.test.ts` -- covers REF-01
- [ ] `src/dispatch/__tests__/callback-helpers.test.ts` -- covers REF-04
- [ ] `src/dispatch/__tests__/trace-helpers.test.ts` -- covers REF-05
- [ ] `src/dispatch/__tests__/lifecycle-handlers.test.ts` -- covers REF-02 (partial)
- [ ] `src/dispatch/__tests__/recovery-handlers.test.ts` -- covers REF-02 (partial)
- [ ] `src/dispatch/__tests__/alert-handlers.test.ts` -- covers REF-02 (partial)
- [ ] `src/tools/__tests__/tool-registry.test.ts` -- covers REF-03
- [ ] `src/openclaw/__tests__/permissions.test.ts` -- covers REF-07

**Note:** Existing tests (`assign-executor.test.ts`, `completion-enforcement.test.ts`, `callback-delivery.test.ts`, etc.) provide integration-level regression coverage. They MUST remain green throughout refactoring. New unit tests cover the extracted helpers directly.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of all four target files (assign-executor.ts, action-executor.ts, mcp/tools.ts, openclaw/adapter.ts)
- Existing test files in dispatch/__tests__/ and tools/__tests__/
- Phase 37 CONTEXT.md and Phase 38 CONTEXT.md for locked decisions

### Secondary (MEDIUM confidence)
- Pattern analysis based on project conventions established in Phases 34-37

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, pure refactoring
- Architecture: HIGH - decisions locked in CONTEXT.md, code analyzed directly
- Pitfalls: HIGH - identified from actual code inspection of closures, duplication patterns, and type mismatches

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable — internal refactoring, no external dependencies)
