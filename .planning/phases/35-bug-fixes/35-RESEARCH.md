# Phase 35: Bug Fixes - Research

**Researched:** 2026-03-12
**Domain:** Correctness bugs in scheduler, daemon, types, concurrency
**Confidence:** HIGH

## Summary

Phase 35 addresses four well-defined correctness bugs. All bugs are localized to specific files with clear root causes and straightforward fixes. The codebase already has the infrastructure needed (task lock manager, status directories, test framework) -- the work is wiring fixes and adding regression tests.

The bugs range from trivial (BUG-03: remove dead type field) to moderate (BUG-04: route scheduler transitions through lock manager). None require architectural changes or new dependencies.

**Primary recommendation:** Fix each bug independently with a dedicated regression test. Per-bug commits for clean bisectability.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- BUG-03: Remove `blockers` field entirely from both `UpdatePatch` and `TransitionOpts` in task-mutations.ts. Field is never read or written anywhere -- dead code, not misplaced code. No backward compatibility concern.

### Claude's Discretion
- BUG-01: How to restructure buildTaskStats to include cancelled/deadletter (straightforward addition)
- BUG-02: Where exactly to place startTime inside startAofDaemon() (move from module scope to function scope)
- BUG-04: How to route scheduler-initiated transitions through task-lock-manager (existing task-lock.ts in protocol/)
- Whether to add regression tests per bug or batch them
- Commit granularity (per-bug or grouped)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| BUG-01 | buildTaskStats counts cancelled and deadletter statuses -- prevents false "all tasks blocked" alerts | Stats object missing `cancelled` and `deadletter` fields; also affects post-execution recalculation at scheduler.ts:376-395 and PollResult.stats type |
| BUG-02 | Daemon startTime initialized inside startAofDaemon() -- not at module load | `const startTime = Date.now()` at daemon.ts:34 (module scope); used at line 101 for uptime calculation in health server |
| BUG-03 | UpdatePatch.blockers removed (confirmed unused) | `blockers` at task-mutations.ts:22 nested inside `routing` (indentation bug), also at TransitionOpts:113 |
| BUG-04 | TOCTOU race mitigated -- scheduler transitions routed through task lock manager | Lock manager exists in protocol/task-lock.ts; scheduler calls acquireLease/store.transition without locking |
</phase_requirements>

## Architecture Patterns

### BUG-01: buildTaskStats Missing Statuses

**File:** `src/dispatch/scheduler-helpers.ts` (lines 13-35)

**Root cause:** `buildTaskStats()` returns an object with only 6 status fields (backlog, ready, inProgress, blocked, review, done). The `cancelled` and `deadletter` statuses are valid (`STATUS_DIRS` in task-store.ts includes all 8) but not counted.

**Impact chain:**
1. `buildTaskStats()` returns stats where `cancelled`/`deadletter` tasks contribute to `total` but no named field
2. In scheduler.ts:468: `const activeTasks = stats.total - stats.done` -- cancelled/deadletter counted as active
3. At scheduler.ts:469: `stats.blocked === activeTasks` -- false positive when cancelled/deadletter tasks exist
4. Result: "ALERT: All active tasks are blocked" fires erroneously

**Secondary impact:** The post-execution stats recalculation at scheduler.ts:376-395 has the same omission. The `PollResult.stats` type at scheduler.ts:90-99 also needs the new fields.

**Fix pattern:**
```typescript
// Add to stats object in buildTaskStats():
cancelled: 0,
deadletter: 0,

// Add to the loop:
else if (s === "cancelled") stats.cancelled++;
else if (s === "deadletter") stats.deadletter++;
```

**Cascade updates needed:**
- `PollResult.stats` type in scheduler.ts (add cancelled/deadletter fields)
- Post-execution recalculation block in scheduler.ts:376-395 (same fields)
- The "all tasks blocked" alert logic at scheduler.ts:468 should subtract `stats.cancelled + stats.deadletter` from activeTasks

### BUG-02: Module-Scope startTime

**File:** `src/daemon/daemon.ts` (line 34)

**Root cause:** `const startTime = Date.now()` is at module scope. It's evaluated when the module is first imported, not when `startAofDaemon()` is called. If the daemon is restarted (or in tests), `startTime` is stale.

**Usage:** Line 101: `uptime: Date.now() - startTime` inside the `getState` closure for the health server.

**Fix pattern:** Move `startTime` inside `startAofDaemon()` so it captures actual daemon start time:
```typescript
export async function startAofDaemon(opts: AOFDaemonOptions): Promise<AOFDaemonContext> {
  const startTime = Date.now();
  // ... rest of function
```

**No other consumers** of the module-level `startTime` exist -- it's only used inside `startAofDaemon()`.

### BUG-03: Stray `blockers` Field in Types

**File:** `src/store/task-mutations.ts`

**Root cause:** Two stray `blockers` fields:
1. `UpdatePatch.blockers` at line 22 -- incorrectly indented inside `routing` block (it's a syntax oddity that TypeScript accepts because `routing` is an object type literal, but `blockers` ends up as a property of `routing`)
2. `TransitionOpts.blockers` at line 113

**Fix:** Per locked decision, remove both `blockers` fields entirely. They are dead code -- nothing reads or writes them.

**Verification:** Grep the codebase for `blockers` usage. The only legitimate reference is `SchedulerAction.blockers` in scheduler.ts:82 which is a different type entirely and should be left alone.

### BUG-04: Scheduler TOCTOU Race

**File:** `src/dispatch/assign-executor.ts`, `src/dispatch/scheduler.ts`, `src/store/lease.ts`

**Root cause:** The scheduler's `acquireLease()` and `store.transition()` calls in action execution are not wrapped in the task lock manager. The protocol router (`src/protocol/router.ts`) already wraps its operations with `lockManager.withLock()`, but scheduler-initiated operations bypass this.

**Race scenario:** Protocol message arrives (e.g., completion.report) while scheduler is simultaneously transitioning the same task. Both read stale state, both write -- last write wins, potentially corrupting task state.

**Current lock usage (protocol/router.ts):**
- `completion.report` -> `lockManager.withLock(taskId, ...)`
- `status.update` -> `lockManager.withLock(taskId, ...)`
- `handoff.request` -> `lockManager.withLock(taskId, ...)`
- `handoff.accepted` / `handoff.rejected` -> `lockManager.withLock(taskId, ...)`
- DAG hop completion -> `lockManager.withLock(taskId, ...)`

**Scheduler calls that need locking (assign-executor.ts):**
- Line 120: `acquireLease(store, action.taskId, ...)` -- lease acquisition + ready->in-progress transition
- Line 248: `store.transition(action.taskId, "blocked", ...)` -- enforcement failure
- Line 439: `store.transition(action.taskId, "blocked", ...)` -- spawn failure

**Fix approach:** The lock manager instance must be shared between the protocol router and the scheduler/action-executor. Options:

**Recommended:** Pass the `TaskLockManager` instance through `SchedulerConfig` and into `executeActions()`. In `assign-executor.ts`, wrap each task's action execution in `lockManager.withLock(taskId, ...)`. The AOFService (which creates both the ProtocolRouter and scheduler config) should create a single `InMemoryTaskLockManager` and pass it to both.

**Key files to modify:**
- `src/dispatch/scheduler.ts` -- add `lockManager` to `SchedulerConfig`
- `src/dispatch/action-executor.ts` -- accept and use lock manager
- `src/dispatch/assign-executor.ts` -- wrap acquireLease/transition in withLock
- `src/service/aof-service.ts` -- create shared lock manager instance, pass to both router and scheduler

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-task locking | Custom mutex/semaphore | `InMemoryTaskLockManager` (already exists) | Promise-chaining approach handles error propagation and cleanup correctly |
| Atomic file writes | `fs.writeFile` | `write-file-atomic` (already used) | Prevents partial writes on crash |

## Common Pitfalls

### Pitfall 1: Forgetting PollResult.stats Type
**What goes wrong:** Adding cancelled/deadletter to buildTaskStats but not updating PollResult.stats type
**Why it happens:** The stats type is defined inline in PollResult, not derived from buildTaskStats return
**How to avoid:** Update both the function return AND the PollResult interface AND the post-execution recalculation block

### Pitfall 2: Lock Manager Scope for BUG-04
**What goes wrong:** Creating separate lock manager instances for router and scheduler
**Why it happens:** Each module independently creates `new InMemoryTaskLockManager()`
**How to avoid:** Single instance created in AOFService, injected into both ProtocolRouter and SchedulerConfig

### Pitfall 3: startTime Closure Capture
**What goes wrong:** Moving startTime inside the function but forgetting that `getState` is a closure
**Why it happens:** The closure already captures from the surrounding scope
**How to avoid:** Just move the `const startTime = Date.now()` to inside `startAofDaemon()` -- the closure will capture the local variable correctly

### Pitfall 4: SchedulerAction.blockers vs UpdatePatch.blockers
**What goes wrong:** Accidentally removing `blockers` from `SchedulerAction` when cleaning up BUG-03
**Why it happens:** Grep for "blockers" returns multiple hits
**How to avoid:** Only remove from `UpdatePatch` and `TransitionOpts` in task-mutations.ts. `SchedulerAction.blockers` in scheduler.ts is a separate, used field.

## Code Examples

### BUG-01 Fix: buildTaskStats
```typescript
// src/dispatch/scheduler-helpers.ts
export function buildTaskStats(allTasks: Task[]) {
  const stats = {
    total: allTasks.length,
    backlog: 0,
    ready: 0,
    inProgress: 0,
    blocked: 0,
    review: 0,
    done: 0,
    cancelled: 0,
    deadletter: 0,
  };

  for (const task of allTasks) {
    const s = task.frontmatter.status;
    if (s === "backlog") stats.backlog++;
    else if (s === "ready") stats.ready++;
    else if (s === "in-progress") stats.inProgress++;
    else if (s === "blocked") stats.blocked++;
    else if (s === "review") stats.review++;
    else if (s === "done") stats.done++;
    else if (s === "cancelled") stats.cancelled++;
    else if (s === "deadletter") stats.deadletter++;
  }

  return stats;
}
```

### BUG-01 Fix: Alert Logic
```typescript
// scheduler.ts - "all tasks blocked" alert (around line 468)
const activeTasks = stats.total - stats.done - stats.cancelled - stats.deadletter;
```

### BUG-04 Fix: Shared Lock Manager
```typescript
// In AOFService or wherever scheduler + router are created:
const lockManager = new InMemoryTaskLockManager();

// Pass to ProtocolRouter
const router = new ProtocolRouter({ store, lockManager, ... });

// Pass to scheduler config
const schedulerConfig: SchedulerConfig = { ..., lockManager };

// In assign-executor.ts action execution:
await lockManager.withLock(action.taskId, async () => {
  const leasedTask = await acquireLease(store, action.taskId, action.agent!, { ... });
  // ... spawn and handle result
});
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | vitest.config.ts (inferred from package.json scripts) |
| Quick run command | `npm run test:unlocked -- --reporter=verbose` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BUG-01 | buildTaskStats counts cancelled/deadletter | unit | `npx vitest run src/dispatch/__tests__/scheduler-helpers.test.ts -x` | Wave 0 |
| BUG-01 | Alert logic excludes cancelled/deadletter from "active" | unit | `npx vitest run src/dispatch/__tests__/scheduler.test.ts -x` | Existing (extend) |
| BUG-02 | startTime reflects daemon start, not module import | unit | `npx vitest run src/daemon/__tests__/daemon.test.ts -x` | Existing (extend) |
| BUG-03 | blockers field removed from UpdatePatch/TransitionOpts | unit | TypeScript compilation (`npx tsc --noEmit`) | N/A (type check) |
| BUG-04 | Scheduler transitions use lock manager | unit | `npx vitest run src/dispatch/__tests__/assign-executor.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose` (relevant test files)
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/dispatch/__tests__/scheduler-helpers.test.ts` -- covers BUG-01 (buildTaskStats with all 8 statuses)
- [ ] BUG-04 tests may need to extend existing assign-executor tests or create new integration test for lock manager wiring

## Sources

### Primary (HIGH confidence)
- Direct source code analysis of all affected files
- `src/dispatch/scheduler-helpers.ts` -- buildTaskStats implementation
- `src/daemon/daemon.ts` -- startTime at module scope (line 34), usage (line 101)
- `src/store/task-mutations.ts` -- UpdatePatch and TransitionOpts types
- `src/protocol/task-lock.ts` -- existing TaskLockManager
- `src/protocol/router.ts` -- existing lock manager usage pattern
- `src/dispatch/assign-executor.ts` -- scheduler transition calls without locking
- `src/store/task-store.ts` -- STATUS_DIRS showing all 8 valid statuses

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new libraries needed, all fixes use existing code
- Architecture: HIGH - all affected files directly inspected, patterns clear
- Pitfalls: HIGH - concrete pitfalls identified from code analysis

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable codebase, bugs are static)
