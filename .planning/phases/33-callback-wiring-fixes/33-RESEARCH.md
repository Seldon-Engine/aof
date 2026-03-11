# Phase 33: Callback Wiring Fixes - Research

**Researched:** 2026-03-11
**Domain:** Integration gap closure (callback delivery wiring + depth propagation)
**Confidence:** HIGH

## Summary

This is a gap closure phase addressing two integration defects found by the v1.8 milestone audit. Both issues are well-understood wiring omissions -- the implementation logic exists and is tested, but the cross-module connections are missing.

**GRAN-02:** `deliverAllGranularityCallbacks` is exported from `callback-delivery.ts` and has full unit test coverage, but is never called from production code. The `onRunComplete` handler in `assign-executor.ts` only calls `deliverCallbacks` (completion-only). All-granularity subscribers are only served by the retry scan on terminal tasks, degrading them to delayed completion-only delivery.

**SAFE-01:** `callbackDepth` is set on `TaskContext.metadata` when spawning callback sessions (lines 241, 305, 343 of callback-delivery.ts), but this value never crosses the MCP session boundary. When a callback agent calls `aof_dispatch`, `handleAofDispatch` in `tools.ts` creates a new task without reading or propagating the session's depth. The depth guard at `callback-delivery.ts:59` reads `frontmatter.callbackDepth` which is always 0/undefined for new tasks, rendering infinite loop prevention ineffective.

**Primary recommendation:** Two surgical fixes -- add `deliverAllGranularityCallbacks` call alongside existing `deliverCallbacks` in both `onRunComplete` branches, and propagate `callbackDepth` through the MCP boundary by adding it to `store.create()` options and reading it from session context in `handleAofDispatch`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GRAN-02 | "all" granularity fires on every state transition | `deliverAllGranularityCallbacks` exists at callback-delivery.ts:189, needs wiring into assign-executor.ts onRunComplete at lines 205-224 and 309-327 |
| SAFE-01 | Infinite callback loops prevented (depth counter) | callbackDepth field exists on TaskFrontmatter (task.ts:115), depth guard exists at callback-delivery.ts:59/196, needs propagation through handleAofDispatch in tools.ts:115 |
</phase_requirements>

## Architecture Analysis

### Current State: GRAN-02

**File:** `src/dispatch/assign-executor.ts`

The `onRunComplete` callback has two branches:
1. **Lines 184-224:** Agent already transitioned task (status != in-progress). Calls `deliverCallbacks` at line 214.
2. **Lines 228-327:** Agent exited without completing. Enforcement logic runs, then calls `deliverCallbacks` at line 318.

Both branches create an inline `SubscriptionStore` and call only `deliverCallbacks`, which filters for `completion` granularity at callback-delivery.ts:69. `deliverAllGranularityCallbacks` is never imported or called.

**Fix pattern:** Import `deliverAllGranularityCallbacks` and call it alongside `deliverCallbacks` in both branches. The function is status-agnostic (no terminal check required), so it can be called regardless of task status. It handles its own subscription filtering (only "all" granularity subs).

### Current State: SAFE-01

**The depth propagation chain (current):**
1. callback-delivery.ts spawns sessions with `metadata: { callbackDepth: depth + 1 }` on TaskContext
2. OpenClawAdapter receives TaskContext but only uses it for prompt formatting -- `metadata` is not passed to the spawned agent's environment
3. Inside the spawned session, a new `AofMcpServer` is created with a fresh `AofMcpContext` that has no knowledge of callbackDepth
4. When callback agent calls `aof_dispatch`, `handleAofDispatch` creates task via `store.create()` without `callbackDepth`
5. New task has `callbackDepth: undefined` (defaults to 0 in the guard)

**The depth propagation chain (needed):**
1. callback-delivery.ts spawns sessions with `metadata: { callbackDepth: depth + 1 }` (already done)
2. The callbackDepth must survive the MCP session boundary
3. `handleAofDispatch` must read callbackDepth from session context and pass it to `store.create()`
4. `store.create()` must accept and persist `callbackDepth` on frontmatter

**Architectural challenge:** The MCP session boundary is the gap. The spawned agent process has no way to know its callbackDepth. Two viable approaches:

**Approach A (Environment variable):** Set `AOF_CALLBACK_DEPTH` env var when spawning callback sessions. `createAofMcpContext` reads it and stores it on `AofMcpContext`. `handleAofDispatch` reads from context and passes to `store.create()`.

**Approach B (Frontmatter field via store.create):** Add `callbackDepth` as an optional parameter to `ITaskStore.create()` and `store.create()`. In `handleAofDispatch`, read callbackDepth from a new field on `AofMcpContext` that is populated from the environment or session init.

Both approaches need the same chain: session metadata -> env/config -> MCP context -> store.create -> frontmatter. The key question is how to cross the process boundary.

**Recommended approach:** Environment variable. The OpenClawAdapter already passes structured params to `runEmbeddedPiAgent`. However, that runs in-process, so we can set the env var before spawning or pass it through the API. For the MCP server case (separate process), environment variables are the standard mechanism.

Specifically:
1. In `callback-delivery.ts`, when building the TaskContext for callback sessions, the metadata already has `callbackDepth`. No change needed here.
2. In `OpenClawAdapter.spawnSession`, read `context.metadata?.callbackDepth` and pass it to the embedded agent env.
3. In `AofMcpContext` (shared.ts), add `callbackDepth: number` field, populated from `process.env.AOF_CALLBACK_DEPTH` or from the adapter passing it.
4. In `handleAofDispatch` (tools.ts), read `ctx.callbackDepth` and pass to `store.create()`.
5. In `ITaskStore.create()` and `FilesystemTaskStore.create()`, add optional `callbackDepth` param, set it on frontmatter.

### File-by-File Impact

| File | Change | Scope |
|------|--------|-------|
| `src/dispatch/assign-executor.ts` | Import + call `deliverAllGranularityCallbacks` in both onRunComplete branches | GRAN-02 |
| `src/dispatch/callback-delivery.ts` | No changes needed (already correct) | -- |
| `src/mcp/shared.ts` | Add `callbackDepth` to `AofMcpContext`, read from env in `createAofMcpContext` | SAFE-01 |
| `src/mcp/tools.ts` | In `handleAofDispatch`, pass `ctx.callbackDepth` to `store.create()` | SAFE-01 |
| `src/store/interfaces.ts` | Add optional `callbackDepth` to `create()` opts | SAFE-01 |
| `src/store/task-store.ts` | Accept `callbackDepth` in `create()`, pass to `TaskFrontmatter.parse()` | SAFE-01 |
| `src/openclaw/openclaw-executor.ts` | Pass `callbackDepth` from context.metadata to spawned agent env | SAFE-01 |

## Common Pitfalls

### Pitfall 1: Calling deliverAllGranularityCallbacks on non-terminal tasks
**What goes wrong:** Calling it when task is still in-progress might attempt to deliver before meaningful transitions exist.
**How to avoid:** `deliverAllGranularityCallbacks` already handles this -- it scans the event log for transitions. If there are no new transitions since last delivery, it skips. No guard needed at the call site. The function is intentionally status-agnostic.

### Pitfall 2: Double-counting completion transitions
**What goes wrong:** Both `deliverCallbacks` (completion-only) and `deliverAllGranularityCallbacks` ("all" granularity) fire on the same task completion. Could potentially double-deliver to a subscriber with "all" granularity.
**How to avoid:** These functions filter on different subscription granularity values. `deliverCallbacks` at line 69 filters `granularity === "completion"`. `deliverAllGranularityCallbacks` at line 206 filters `granularity === "all"`. No overlap. They serve disjoint subscriber sets.

### Pitfall 3: Race between inline deliverCallbacks and deliverAllGranularityCallbacks
**What goes wrong:** Both async calls run in the same try block. If one fails, the catch swallows both.
**How to avoid:** Wrap each in its own try/catch, consistent with the existing pattern. Both are best-effort (DLVR-04).

### Pitfall 4: Environment variable not cleared between sessions
**What goes wrong:** If `AOF_CALLBACK_DEPTH` persists across agent sessions in the same process, normal (non-callback) dispatches might inherit a stale depth.
**How to avoid:** Only set the env var for callback sessions. Use `AofMcpOptions` to explicitly pass callbackDepth rather than relying solely on env. For embedded agents (OpenClawAdapter), pass as a spawn parameter. Default to 0 if unset.

### Pitfall 5: store.create interface change breaks existing callers
**What goes wrong:** Adding `callbackDepth` to `ITaskStore.create()` breaks all existing mock implementations in tests.
**How to avoid:** Make it optional. Existing callers pass undefined by default. Zod schema already has `callbackDepth` as optional on TaskFrontmatter.

## Code Examples

### GRAN-02: Wiring deliverAllGranularityCallbacks

Both `onRunComplete` branches in assign-executor.ts follow the same pattern. Here is the addition for the first branch (lines 205-224):

```typescript
// Existing: completion-only delivery
import { deliverCallbacks, deliverAllGranularityCallbacks } from "./callback-delivery.js";

// In onRunComplete, after the existing deliverCallbacks call:
// --- All-granularity delivery (Phase 33) --- best-effort, never blocks transitions
try {
  const tasksDir = store.tasksDir;
  const taskDirResolver = async (tid: string): Promise<string> => {
    const t = await store.get(tid);
    if (!t) throw new Error(`Task not found: ${tid}`);
    return join(tasksDir, t.frontmatter.status, tid);
  };
  const subscriptionStore = new SubscriptionStore(taskDirResolver);
  await deliverAllGranularityCallbacks({
    taskId: action.taskId,
    store,
    subscriptionStore,
    executor: config.executor!,
    logger,
  });
} catch {
  // Delivery must never crash the scheduler
}
```

Note: The existing `deliverCallbacks` and the new `deliverAllGranularityCallbacks` use the same `DeliverCallbacksOptions` interface. They can share the same SubscriptionStore instance to avoid double-construction.

### SAFE-01: Depth propagation through MCP boundary

**shared.ts additions:**
```typescript
export interface AofMcpOptions {
  // ... existing fields ...
  /** Callback depth for callback sessions (propagated from parent). */
  callbackDepth?: number;
}

export interface AofMcpContext {
  // ... existing fields ...
  /** Callback chain depth -- 0 for normal sessions, incremented for callback-spawned sessions. */
  callbackDepth: number;
}

// In createAofMcpContext:
const callbackDepth = options.callbackDepth
  ?? parseInt(process.env.AOF_CALLBACK_DEPTH ?? "0", 10)
  || 0;
```

**tools.ts handleAofDispatch additions:**
```typescript
// After creating the task, set callbackDepth on frontmatter if > 0
const task = await ctx.store.create({
  // ... existing params ...
  callbackDepth: ctx.callbackDepth > 0 ? ctx.callbackDepth : undefined,
});
```

**interfaces.ts and task-store.ts:**
```typescript
// Add to create opts:
callbackDepth?: number;

// In FilesystemTaskStore.create(), add to TaskFrontmatter.parse():
...(opts.callbackDepth !== undefined ? { callbackDepth: opts.callbackDepth } : {}),
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Subscription filtering | Custom filter logic per call site | `deliverCallbacks` / `deliverAllGranularityCallbacks` existing APIs | Already filter by granularity internally |
| Depth checking | Manual depth check at call sites | Existing depth guards at callback-delivery.ts:59,196 | Already implemented and tested |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | vitest.config.ts |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GRAN-02 | deliverAllGranularityCallbacks called from onRunComplete | integration | `npx vitest run src/dispatch/__tests__/assign-executor.test.ts -t "deliverAllGranularity"` | Wave 0 (new tests) |
| GRAN-02 | Both onRunComplete branches call deliverAllGranularityCallbacks | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "deliverAllGranularity"` | Existing (unit only) |
| SAFE-01 | callbackDepth propagated through handleAofDispatch | integration | `npx vitest run src/mcp/__tests__/tools.test.ts -t "callbackDepth"` | Wave 0 (new tests) |
| SAFE-01 | store.create accepts callbackDepth | unit | `npx vitest run src/store/__tests__/task-store.test.ts -t "callbackDepth"` | Wave 0 (new tests) |
| SAFE-01 | AofMcpContext reads callbackDepth from env/options | unit | `npx vitest run src/mcp/__tests__/shared.test.ts -t "callbackDepth"` | Wave 0 (new test file or addition) |

### Sampling Rate
- **Per task commit:** `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts src/dispatch/__tests__/assign-executor.test.ts src/mcp/__tests__/tools.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Integration test: assign-executor onRunComplete calls deliverAllGranularityCallbacks
- [ ] Unit test: store.create with callbackDepth produces correct frontmatter
- [ ] Integration test: handleAofDispatch propagates callbackDepth from context to created task
- [ ] Unit test: createAofMcpContext reads callbackDepth from options and env

## Open Questions

1. **How does callbackDepth cross the OpenClaw embedded agent process boundary?**
   - What we know: OpenClawAdapter runs agents via `runEmbeddedPiAgent` in-process. The agent runs in the same Node process, so setting `process.env.AOF_CALLBACK_DEPTH` before spawning would be visible. However, the agent creates its own MCP server via `AofMcpServer`.
   - What's unclear: Whether the embedded agent creates its MCP server before or after the env var would be set. Since `runEmbeddedPiAgent` is async and fire-and-forget, the env var approach may have race conditions with concurrent spawns.
   - Recommendation: Pass `callbackDepth` through `AofMcpOptions` rather than env vars for in-process spawns. For the env var path, it serves as a fallback for out-of-process MCP servers. The adapter should set it on the spawned agent's options if possible, or use a unique env var per spawn.

2. **Should deliverAllGranularityCallbacks share the SubscriptionStore instance with deliverCallbacks?**
   - What we know: Both calls construct inline SubscriptionStore with the same resolver pattern.
   - Recommendation: Share the instance to avoid redundant construction. Construct once, pass to both calls.

## Sources

### Primary (HIGH confidence)
- Direct source code analysis of all affected files
- `src/dispatch/assign-executor.ts` -- onRunComplete at lines 175-328
- `src/dispatch/callback-delivery.ts` -- full file, exports and internal logic
- `src/mcp/tools.ts` -- handleAofDispatch at line 115
- `src/mcp/shared.ts` -- AofMcpContext interface and createAofMcpContext
- `src/schemas/task.ts` -- TaskFrontmatter.callbackDepth at line 115
- `src/store/interfaces.ts` -- ITaskStore.create interface
- `src/store/task-store.ts` -- FilesystemTaskStore.create at line 172
- `src/openclaw/openclaw-executor.ts` -- OpenClawAdapter.spawnSession
- `.planning/v1.8-MILESTONE-AUDIT.md` -- Gap definitions

## Metadata

**Confidence breakdown:**
- GRAN-02 fix: HIGH - Pure wiring, function already exists and is tested, call site clearly identified
- SAFE-01 fix: HIGH for the approach, MEDIUM for the env var propagation specifics (depends on OpenClaw adapter internals)
- Pitfalls: HIGH - Well-understood from code analysis

**Research date:** 2026-03-11
**Valid until:** 2026-04-11 (stable internal codebase)
