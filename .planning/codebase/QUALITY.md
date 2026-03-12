# Codebase Quality Issues

**Analysis Date:** 2026-03-12

## 1. Code Duplication

### 1a. OpenClaw Adapter Tool Registration Boilerplate

**Files:** `src/openclaw/adapter.ts` (lines 208-523)

Every tool registration in the OpenClaw adapter repeats the same 6-line pattern:

```typescript
execute: async (_id: string, params: Record<string, unknown>) => {
  const actor = (params as any).actor;
  const projectId = (params as any).project as string | undefined;
  const projectStore = resolveProjectStore(projectId);
  const permissionStore = await getStoreForActor(actor, projectStore);
  const result = await aofSomeTool({ store: permissionStore, logger, projectId }, params as any);
  return wrapResult(result);
},
```

This identical block is copy-pasted **10 times** (dispatch, update, status_report, complete, edit, cancel, dep_add, dep_remove, block, unblock). Each uses `(params as any)` casts throughout.

**Fix:** Extract a generic `withPermissions` higher-order function:

```typescript
function withPermissions<T>(
  fn: (ctx: ToolContext, params: T) => Promise<unknown>
) {
  return async (_id: string, params: Record<string, unknown>) => {
    const actor = (params as Record<string, string>).actor;
    const projectId = (params as Record<string, string>).project;
    const projectStore = resolveProjectStore(projectId);
    const permissionStore = await getStoreForActor(actor, projectStore);
    return wrapResult(await fn({ store: permissionStore, logger, projectId }, params as T));
  };
}
```

### 1b. MCP Tool Registration Boilerplate

**Files:** `src/mcp/tools.ts` (lines 668-781)

Every `server.registerTool` call wraps the result identically:

```typescript
async (input) => ({
  content: [{ type: "text" as const, text: JSON.stringify(await handleX(ctx, input), null, 2) }],
})
```

Repeated **14 times**. Should be a shared wrapper.

### 1c. Callback Delivery Setup Duplication

**File:** `src/dispatch/assign-executor.ts` (lines 206-230 and 317-341)

The same callback delivery setup code appears **twice** in the same function, in two branches of `onRunComplete`:

```typescript
const tasksDir = store.tasksDir;
const taskDirResolver = async (tid: string): Promise<string> => {
  const t = await store.get(tid);
  if (!t) throw new Error(`Task not found: ${tid}`);
  return join(tasksDir, t.frontmatter.status, tid);
};
const subscriptionStore = new SubscriptionStore(taskDirResolver);
const callbackOpts = { taskId: action.taskId, store, subscriptionStore, executor: config.executor!, logger };
try { await deliverCallbacks(callbackOpts); } catch { }
try { await deliverAllGranularityCallbacks(callbackOpts); } catch { }
```

The second copy uses `tasksDir2`, `taskDirResolver2`, `subscriptionStore2`, `callbackOpts2` -- identical logic, different variable names.

**Fix:** Extract to a local helper function `deliverAllCallbacksSafely(taskId)` called from both branches.

### 1d. Trace Capture Duplication

**File:** `src/dispatch/assign-executor.ts` (lines 186-203 and 296-314)

Trace capture code is duplicated in the same two `onRunComplete` branches with the same pattern.

### 1e. Gate-to-DAG Migration Check Duplication

**File:** `src/store/task-store.ts` (lines 252, 292, 343)

The same lazy migration block is repeated **3 times** in `get()`, `getByPrefix()`, and `list()`:

```typescript
if ((task.frontmatter as any).gate && !task.frontmatter.workflow) {
  const workflowConfig = await this.loadWorkflowConfig();
  migrateGateToDAG(task, workflowConfig);
  if (task.frontmatter.workflow) {
    await writeFileAtomic(filePath, serializeTask(task));
  }
}
```

**Fix:** Extract a `migrateIfNeeded(task, filePath)` private method.

---

## 2. Inconsistent Patterns

### 2a. Error Handling: Silent Catch Blocks

**Scope:** 150+ `catch {` blocks across the codebase (non-test files)

The codebase uses three different error suppression patterns with no consistency:

1. **Empty catch with comment** (most common in dispatch/): `catch { // Logging errors should not crash the scheduler }` -- 36 occurrences in dispatch/ alone
2. **Bare empty catch**: `catch { }` or `catch { /* ignore */ }` -- common in CLI, packaging, memory
3. **Catch-and-continue**: `catch { continue; }` -- in store iteration

Many of these suppress errors that could indicate real problems (file system failures, serialization errors). There is no centralized "safe-log" or "try-or-ignore" utility.

**Fix:** Create a `safeTry(fn, label?)` or `safeLog(logger, ...)` utility for the ~36 "logging errors should not crash" cases. For other catches, add structured logging.

### 2b. Logging: console.* vs EventLogger

**Scope:** 751 `console.*` calls across 60 non-test source files

The codebase mixes `console.log/warn/error/info` (raw stdout) with `EventLogger` (structured JSONL). Files like `src/dispatch/action-executor.ts` use **both** in adjacent lines:

```typescript
console.error(`[AOF] Spawn failed for ${action.taskId}...`);
// ...
await logger.logDispatch("dispatch.error", "scheduler", ...);
```

High-frequency offenders:
- `src/cli/commands/memory.ts`: 77 console calls
- `src/cli/commands/project.ts`: 79 console calls
- `src/cli/commands/config-commands.ts`: 36 console calls
- `src/dispatch/action-executor.ts`: 15 console calls
- `src/service/aof-service.ts`: 15 console calls

CLI commands using `console.*` is expected. But core modules (`dispatch/`, `service/`, `protocol/`) should use the structured logger exclusively.

### 2c. `(store as any).tasksDir` Pattern

**Files:** `src/context/manifest.ts` (lines 33, 80), `src/context/assembler.ts` (line 59)

Three locations cast `ITaskStore` to `any` to access `tasksDir`, even though `tasksDir` IS on the `ITaskStore` interface (confirmed in `src/store/interfaces.ts` line 23). This is unnecessary and indicates the type annotations in these files are wrong (likely using a narrower type).

**Fix:** Use `store.tasksDir` directly -- it is part of the interface.

### 2d. `this.logger as any` Casts in TaskStore

**File:** `src/store/task-store.ts` (lines 415, 459)

The `logger` property is typed as `EventLogger | undefined` but passed to extracted functions that require a different type signature:

```typescript
this.logger as any,
```

**Fix:** Align the function signatures to accept `EventLogger | undefined` or create a narrower interface.

---

## 3. Overly Complex Functions

### 3a. `executeActions()` -- 415-line switch statement

**File:** `src/dispatch/action-executor.ts` (lines 46-415)

Single function with a massive `switch` statement handling 11 action types. The `expire_lease` case alone (lines 67-148) has 4 levels of nesting. The `stale_heartbeat` case (lines 150-224) has 3 levels. Each case duplicates the "try logger, catch ignore" pattern.

**Fix:** Extract each case into a named handler function: `handleExpireLease()`, `handleStaleHeartbeat()`, `handleRequeue()`, etc.

### 3b. `executeAssignAction()` -- 544 lines

**File:** `src/dispatch/assign-executor.ts` (lines 62-528)

This function handles lease acquisition, metadata writing, context building, agent spawning, completion callbacks, trace capture, error classification, retry tracking, deadletter transitions, and metrics -- all in a single function with deeply nested `onRunComplete` callback.

The `onRunComplete` callback alone spans ~170 lines (172-342) and contains two nearly identical branches for callback delivery.

### 3c. `poll()` function in scheduler

**File:** `src/dispatch/scheduler.ts` -- 585 lines total

The scheduler module does gate evaluation, DAG transitions, SLA checking, murmur triggers, backlog promotion, blocked task recovery, and action execution. While partially decomposed into helpers, the `poll()` function still orchestrates too much inline.

---

## 4. Type Safety Issues

### 4a. `as any` in Production Code

**9 non-test source files** use `as any` casts. Notable:

| File | Count | Nature |
|------|-------|--------|
| `src/openclaw/adapter.ts` | 20+ | Every tool `execute` casts `params as any` |
| `src/store/task-store.ts` | 5 | `(task.frontmatter as any).gate`, `this.logger as any` |
| `src/config/manager.ts` | 3 | `current: any`, `item: any` in config traversal |
| `src/context/manifest.ts` | 3 | `(store as any).tasksDir`, `err: any`, `manifest: any` |
| `src/memory/curation-generator.ts` | 1 | `status as any` |
| `src/projects/lint.ts` | 3 | `statusName as any`, `Record<string, any>` |
| `src/migration/gate-to-dag.ts` | 2 | `Record<string, any>` for frontmatter |

### 4b. `(task.frontmatter as any).gate` -- Untyped Legacy Field

**File:** `src/store/task-store.ts` (lines 252, 292, 343)

The `gate` field from the deprecated gate workflow schema is not part of the `TaskFrontmatter` type, so it is accessed via `as any`. This pattern should use a type guard or extend the type with an optional legacy field.

### 4c. Untyped Metadata Access

**Files:** `src/dispatch/action-executor.ts`, `src/dispatch/assign-executor.ts`

`task.frontmatter.metadata` is typed as `Record<string, unknown>` but accessed with assumed field names throughout:

```typescript
const blockReason = expiringTask.frontmatter.metadata?.blockReason as string | undefined;
const retryCount = ((currentTask?.frontmatter.metadata?.retryCount as number) ?? 0) + 1;
const correlationId = staleTask.frontmatter.metadata?.correlationId as string | undefined;
```

No type narrowing or validation -- each access is a cast-and-hope pattern.

**Fix:** Define a `TaskMetadataFields` interface for known metadata keys and use it.

---

## 5. Deprecated Code Still in Use

### 5a. Gate Workflow System (deprecated since v1.2)

Multiple deprecated modules are still actively imported:

| Deprecated Module | Imported By |
|---|---|
| `src/schemas/workflow.ts` | `src/schemas/project.ts`, `src/dispatch/scheduler.ts`, `src/dispatch/gate-evaluator.ts`, `src/dispatch/gate-context-builder.ts`, `src/dispatch/escalation.ts` |
| `src/dispatch/gate-evaluator.ts` | `src/dispatch/scheduler.ts` |
| `src/dispatch/gate-context-builder.ts` | `src/dispatch/assign-executor.ts`, `src/dispatch/executor.ts` |
| `src/dispatch/gate-conditional.ts` | `src/dispatch/gate-evaluator.ts` |
| `src/schemas/gate.ts` | Multiple dispatch modules |

The lazy gate-to-DAG migration in `src/store/task-store.ts` means these deprecated code paths are still exercised at runtime.

### 5b. Deprecated Executor Types

**File:** `src/dispatch/executor.ts` (lines 49, 115, 284)

Three deprecated type aliases exist: `DispatchResult` (use `SpawnResult`), `Executor` (use `GatewayAdapter`), `MockExecutor` (use `MockAdapter`). These are re-exported from `src/dispatch/index.ts`.

### 5c. Deprecated Notifier in AOFService

**File:** `src/service/aof-service.ts` (line 42-43)

```typescript
/** @deprecated Pass `engine` instead. Will be removed in a future release. */
notifier?: NotificationService;
```

Still accepted in the constructor and stored as `this.notifier`.

---

## 6. Dead/Commented-Out Code

### 6a. Commented Import

**File:** `src/schemas/event.ts` (line 14)

```typescript
// import type { TaskStatus } from "./task.js";
```

### 6b. Unused Output Schemas in MCP Tools

**File:** `src/mcp/tools.ts`

Multiple output schemas are defined but never used by `registerTool` calls (MCP SDK does not require output schemas for tool registration). Examples:
- `dispatchOutputSchema` (line 31)
- `taskUpdateOutputSchema` (line 50)
- `taskCompleteOutputSchema` (line 65)
- `statusReportOutputSchema` (line 80)
- `boardOutputSchema` (line 99)
- `taskEditOutputSchema` (line 334)
- `taskCancelOutputSchema` (line 368)
- `taskBlockOutputSchema` (line 401)
- `taskUnblockOutputSchema` (line 433)
- `taskDepAddOutputSchema` (line 463)
- `taskDepRemoveOutputSchema` (line 496)
- `taskSubscribeOutputSchema` (line 529)
- `taskUnsubscribeOutputSchema` (line 592)

13 output schemas consuming ~100 lines that serve no runtime purpose.

---

## 7. Error Handling Gaps

### 7a. Swallowed Errors in Scheduler/Dispatch

**Files:** `src/dispatch/action-executor.ts`, `src/dispatch/assign-executor.ts`

36 instances of:
```typescript
} catch {
  // Logging errors should not crash the scheduler
}
```

While the intent is valid (logging should not be fatal), errors are completely invisible. No fallback logging, no metrics counter, no health check integration. A persistent logging failure would be completely silent.

**Fix:** At minimum, increment a counter or write to stderr as a last resort.

### 7b. `loadWorkflowConfig()` Swallows All Errors

**File:** `src/store/task-store.ts` (lines 91-108)

```typescript
} catch {
  // No manifest or parse error -- migration not possible
}
return undefined;
```

A malformed `project.yaml` silently prevents gate-to-DAG migration with no visibility.

### 7c. Context Module Casts `err: any` Instead of Typed Catch

**File:** `src/context/manifest.ts` (line 45)

```typescript
} catch (err: any) {
  if (err.code === "ENOENT") {
```

Uses `err: any` to access `.code`. Should use `NodeJS.ErrnoException` or check with `instanceof`.

---

## 8. Structural Issues

### 8a. `assign-executor.ts` Has Multiple Responsibilities

**File:** `src/dispatch/assign-executor.ts` (544 lines)

Contains:
- `loadProjectManifest()` -- project manifest loading (should be in projects/)
- `executeAssignAction()` -- lease, spawn, error handling
- Inline `onRunComplete` callback with trace capture, callback delivery, enforcement
- `buildDispatchActions()` export (at bottom, not shown in read)

The `onRunComplete` callback is a closure over `action`, `store`, `logger`, `config` with its own complex error recovery logic.

### 8b. Three Parallel Tool Registration Systems

The codebase registers the same tools in three places with different APIs:

1. **OpenClaw adapter** (`src/openclaw/adapter.ts`) -- JSON Schema parameters, `api.registerTool()`
2. **MCP server** (`src/mcp/tools.ts`) -- Zod schemas, `server.registerTool()`
3. **Direct functions** (`src/tools/aof-tools.ts`) -- TypeScript types

The handler logic in #1 and #2 is different. #1 uses `(params as any)` everywhere; #2 uses proper Zod parsing. This means bug fixes or behavior changes must be applied in multiple places.

**Fix:** Share handler functions between OpenClaw and MCP registration, with a thin adapter layer for each.

---

## Priority Summary

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| High | 3-system tool duplication (#1a, #1b, #8b) | Bug divergence between OpenClaw/MCP | Medium |
| High | `assign-executor.ts` complexity (#3b) | Hard to debug dispatch failures | High |
| High | Deprecated gate code still active (#5a) | Dead code paths, migration risk | High |
| Medium | Silent error swallowing (#7a) | Invisible failures in production | Low |
| Medium | `as any` in adapter.ts (#4a) | No type safety on tool params | Medium |
| Medium | Callback delivery duplication (#1c, #1d) | Copy-paste bugs | Low |
| Medium | Untyped metadata access (#4c) | Runtime type errors possible | Medium |
| Low | Unused output schemas (#6b) | Code bloat | Low |
| Low | console.* in core modules (#2b) | Unstructured logs | Medium |
| Low | `(store as any).tasksDir` (#2c) | Unnecessary cast | Low |

---

*Quality analysis: 2026-03-12*
