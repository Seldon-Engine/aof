# Codebase Concerns

**Analysis Date:** 2026-03-12

## Tech Debt

**Legacy Gate System Not Removed (v1.3 Promised Removal):**
- Issue: Five files marked `@deprecated` with "Will be removed in v1.3" still exist and are actively imported from production code. The v1.3 removal never happened; the codebase is now at v1.9.
- Files:
  - `src/schemas/gate.ts` — gate schema types (GateOutcome, Gate, GateHistoryEntry, ReviewContext, GateTransition, TestSpec)
  - `src/schemas/workflow.ts` — WorkflowConfig, RejectionStrategy, validateWorkflow
  - `src/dispatch/gate-evaluator.ts` — evaluateGateTransition (365 lines)
  - `src/dispatch/gate-conditional.ts` — evaluateGateCondition, validateGateCondition, buildGateContext (165 lines)
  - `src/dispatch/gate-context-builder.ts` — buildGateContext (239 lines)
- Impact: ~900 lines of deprecated code. Gate types are still exported from `src/schemas/index.ts` (lines 94-101) and `src/dispatch/index.ts` (lines 11-18). Active production code in `src/dispatch/assign-executor.ts` (lines 150-169) still builds gate context for dispatch. `src/dispatch/scheduler.ts` imports gate symbols (lines 22, 25, 27) that are never used in the function body. `src/dispatch/escalation.ts` runs `checkGateTimeouts()` on every poll cycle even though no gate-format tasks should exist.
- Fix approach: (1) Remove gate files: `src/schemas/gate.ts`, `src/schemas/workflow.ts`, `src/dispatch/gate-evaluator.ts`, `src/dispatch/gate-conditional.ts`, `src/dispatch/gate-context-builder.ts`. (2) Remove gate exports from `src/schemas/index.ts` and `src/dispatch/index.ts`. (3) Remove gate context injection from `src/dispatch/assign-executor.ts` lines 150-169. (4) Remove `checkGateTimeouts` from `src/dispatch/escalation.ts` and its call in `src/dispatch/scheduler.ts` line 248. (5) Remove lazy gate-to-DAG migration from `src/store/task-store.ts` and `src/migration/gate-to-dag.ts`.

**Massive Unused Import Accumulation in scheduler.ts:**
- Issue: `src/dispatch/scheduler.ts` imports 18+ symbols that are never used in its function body. These were likely used before extraction to sub-modules (assign-executor.ts, action-executor.ts, scheduler-helpers.ts) but never cleaned up.
- Files: `src/dispatch/scheduler.ts` lines 8-27
- Unused imports: `FilesystemTaskStore`, `serializeTask` (line 8), `acquireLease`, `expireLeases`, `releaseLease` (line 11), `markRunArtifactExpired`, `readRunResult` (line 12), `resolveCompletionTransitions` (line 13), `relative` (line 15), `writeFileAtomic` (line 19), `TaskContext`, `GatewayAdapter` (line 20), `evaluateGateTransition`, `GateEvaluationInput`, `GateEvaluationResult` (line 22), `validateWorkflow`, `WorkflowConfig` (line 23), `ProjectManifest` (line 24), `GateOutcome`, `GateTransition` (line 25), `parseDuration` (line 26), `buildGateContext` (line 27)
- Impact: Slower module loading, misleading dependency graph, approximately 15 unnecessary module resolutions on every import.
- Fix approach: Delete all unused import lines. TypeScript compiler will validate correctness.

**Deprecated Type Aliases Still Exported:**
- Issue: `DispatchExecutor`, `ExecutorResult`, `MockExecutor` are deprecated type aliases still exported from `src/dispatch/index.ts` (lines 3, 5-8) and defined in `src/dispatch/executor.ts` (lines 49-50, 115-116, 284-285). No non-test code imports these deprecated names.
- Files: `src/dispatch/executor.ts`, `src/dispatch/index.ts`
- Impact: Public API surface includes deprecated symbols that could confuse consumers.
- Fix approach: Remove the deprecated aliases and their re-exports.

**Lazy Gate-to-DAG Migration on Every Read:**
- Issue: Every `get()`, `getByPrefix()`, and `list()` call in `FilesystemTaskStore` checks for gate fields and potentially writes back a migrated task file. This runs on every single task read.
- Files: `src/store/task-store.ts` lines 251-258 (get), 292-298 (getByPrefix), 343-352 (list)
- Impact: Unnecessary I/O overhead on every task read. Also uses dynamic `import()` for `node:fs/promises` and `yaml` inside `loadWorkflowConfig()` (lines 92-94) despite both already being statically imported at the top of the file.
- Fix approach: Remove the gate-to-DAG migration code from the task store. No gate-format tasks should exist post-v1.3.

## Known Bugs

**UpdatePatch `blockers` Field Misplaced Inside `routing` Type:**
- Symptoms: The `blockers` field in the `UpdatePatch` interface is nested inside the `routing` object type due to incorrect indentation/placement. It appears to be a stray field that should be at the top level of `UpdatePatch` or removed entirely.
- Files: `src/store/task-mutations.ts` lines 14-25
- Trigger: `patch.routing.blockers` is never accessed anywhere in `updateTask()` (lines 31-108). If a caller passes `{ routing: { blockers: [...] } }`, the blockers are silently discarded.
- Workaround: Field is unused, so no runtime impact currently. But the type signature is misleading.

**`buildTaskStats` Missing `cancelled` and `deadletter` Status Counts:**
- Symptoms: `stats.total` includes all tasks but the status breakdown only counts 6 of the 8 status types (backlog, ready, in-progress, blocked, review, done). Tasks in `cancelled` or `deadletter` are silently untracked, making `stats.total > sum(individual counts)`.
- Files: `src/dispatch/scheduler-helpers.ts` lines 13-35; same issue in recalculation at `src/dispatch/scheduler.ts` lines 386-403
- Trigger: When tasks exist in cancelled or deadletter status, the "all active tasks blocked" alert at `src/dispatch/scheduler.ts` line 477 uses `activeTasks = stats.total - stats.done` which incorrectly includes cancelled/deadletter tasks as "active," potentially triggering false alerts or missing real alerts.
- Workaround: Currently low impact in normal operation but produces incorrect stats in PollResult.

**Daemon `startTime` Set at Module Load, Not Daemon Start:**
- Symptoms: `const startTime = Date.now()` is a module-level constant at `src/daemon/daemon.ts` line 34. The uptime calculation at line 101 (`Date.now() - startTime`) measures time since module import, not since `startAofDaemon()` was called.
- Files: `src/daemon/daemon.ts` line 34, used at line 101
- Trigger: If the daemon module is imported early (e.g., during test setup or CLI initialization) but the daemon is started later, uptime will be artificially inflated.
- Workaround: Move `startTime` initialization into `startAofDaemon()`.

**Duplicate JSDoc Comment on `create()` Method:**
- Symptoms: Two identical `/** Create a new task. Returns the created Task. */` comments on consecutive lines.
- Files: `src/store/task-store.ts` lines 170-171
- Trigger: Cosmetic only, no runtime impact.

## Security Considerations

**Gate Conditional Uses `new Function()` for Expression Evaluation:**
- Risk: `evaluateGateCondition` in `src/dispatch/gate-conditional.ts` lines 98-113 uses `new Function()` constructor to evaluate user-provided `when` field expressions from task files. While this is deprecated code, the lazy migration path in the task store means gate-format tasks could still trigger this code.
- Files: `src/dispatch/gate-conditional.ts` lines 94-131
- Current mitigation: `"use strict"` mode, parameters limited to `tags`, `metadata`, `gateHistory`. However, the timeout check (lines 117-121) runs AFTER execution, so it cannot prevent a synchronous malicious expression from completing.
- Recommendations: Remove this code as part of gate system cleanup. The DAG condition evaluator (`src/dispatch/dag-condition-evaluator.ts`) uses a safe JSON DSL approach.

## Performance Bottlenecks

**229 Swallowed Catch Blocks Across 72 Files:**
- Problem: 229 instances of `} catch {` (empty catch with no error variable or logging) across 72 source files. While many are intentional ("logging/delivery/trace errors should not crash the scheduler"), this pattern makes debugging extremely difficult.
- Files: Highest concentrations in `src/dispatch/assign-executor.ts` (15 instances), `src/dispatch/action-executor.ts` (13), `src/packaging/installer.ts` (9), `src/cli/commands/setup.ts` (9), `src/packaging/updater.ts` (8), `src/dispatch/escalation.ts` (7)
- Cause: Defensive "never crash the scheduler" pattern applied pervasively.
- Improvement path: Replace `} catch {` with `} catch (err) { if (process.env.AOF_DEBUG) console.debug(err); }` or a `safeLog()` wrapper. This preserves crash safety while enabling debugging.

**`nextTaskId` Scans All Status Directories on Every Create:**
- Problem: `FilesystemTaskStore.nextTaskId()` in `src/store/task-store.ts` lines 111-137 reads all 8 status directories and scans all `.md` filenames to find the max sequence number for the current date.
- Cause: No index or counter maintained; every `create()` does 8 `readdir()` calls.
- Improvement path: Maintain a `.aof/task-counter` file or in-memory counter that syncs on startup.

## Fragile Areas

**Module-Level Mutable State in Dispatch:**
- Files:
  - `src/dispatch/scheduler.ts` line 110: `let effectiveConcurrencyLimit: number | null = null` — global concurrency limit with no reset mechanism
  - `src/dispatch/throttle.ts` lines 13-17: `const throttleState` — global throttle state with `resetThrottleState()` for testing
  - `src/dispatch/lease-manager.ts` line 15: `const leaseRenewalTimers = new Map<string, NodeJS.Timeout>()` — active interval timers with no full-reset function
- Why fragile: Three separate module-level mutable singletons persist across poll cycles. `effectiveConcurrencyLimit` is never reset (only updated when a new platform limit is detected). If tests import these modules, state leaks between test cases.
- Safe modification: Always call `resetThrottleState()` in test cleanup. Consider encapsulating all dispatch state in a `SchedulerState` class passed to `poll()`.
- Test coverage: `resetThrottleState()` exists for throttle; `cleanupLeaseRenewals()` partially handles timers; no equivalent for `effectiveConcurrencyLimit`.

**Task Transition TOCTOU Race Condition:**
- Files: `src/store/task-mutations.ts` lines 135-219 (transitionTask), `src/store/lease.ts` lines 45-103 (acquireLease)
- Why fragile: `transitionTask` reads a task, validates status, writes, then renames. Between the read and the rename, another concurrent caller could read the same task and attempt a conflicting transition. `acquireLease` has the same pattern: read, check lease status, write. The `InMemoryTaskLockManager` in `src/protocol/task-lock.ts` exists but is only used in the protocol router — scheduler-initiated transitions via `store.transition()` bypass it entirely.
- Safe modification: Route all state-mutating operations through the task lock manager, or move to compare-and-swap file operations.
- Test coverage: `src/protocol/__tests__/concurrent-handling.test.ts` tests the lock manager, but scheduler-path concurrent transitions are not tested.

**Duplicate `loadProjectManifest` Implementations:**
- Files:
  - `src/dispatch/assign-executor.ts` lines 34-49 — checks `store.projectId === projectId` for path optimization (reads from project root or projects/ subdir)
  - `src/dispatch/escalation.ts` lines 34-46 — always uses `projects/<projectId>/project.yaml` path (no self-project check)
- Why fragile: The escalation version will fail to find the manifest for the store's own project if its `project.yaml` is at the project root. Behavior diverges silently.
- Safe modification: Extract to a shared `loadProjectManifest` utility used by both modules.

**Concurrent Task ID Generation:**
- Files: `src/store/task-store.ts` lines 111-137 (nextTaskId)
- Why fragile: Two concurrent `create()` calls within the same event loop tick could both scan directories, compute the same next ID, and one would silently overwrite the other via `writeFileAtomic`. No locking mechanism exists.
- Safe modification: Use an atomic increment file or in-memory counter with file-system persistence.

## Stale Code

**Reference to Non-Existent `gate-transition-handler.ts`:**
- Problem: `src/dispatch/dag-transition-handler.ts` line 6 JSDoc says "Mirrors the gate-transition-handler.ts pattern" but no file named `gate-transition-handler.ts` exists anywhere in the codebase.
- Files: `src/dispatch/dag-transition-handler.ts` line 6
- Fix: Remove the stale reference from the JSDoc comment.

**Commented-Out Code in `promotion.ts`:**
- Problem: Lines 72-76 contain commented-out code for a "Phase 2" approval gate check that was never implemented.
- Files: `src/dispatch/promotion.ts` lines 72-76
- Fix: Delete the commented-out code. Track the feature as a task if needed.

**Commented-Out Import in `event.ts`:**
- Problem: Line 14 contains `// import type { TaskStatus } from "./task.js";` with comment "will be used when we add typed event constructors."
- Files: `src/schemas/event.ts` lines 13-14
- Fix: Delete the commented-out import.

**Stale `@deprecated` JSDoc Saying "Will be removed in v1.3":**
- Problem: Five deprecated files promise removal in v1.3, but the codebase is at v1.9. The notices are misleading and create false urgency.
- Files: `src/schemas/gate.ts:12`, `src/schemas/workflow.ts:9`, `src/dispatch/gate-evaluator.ts:14`, `src/dispatch/gate-conditional.ts:16`, `src/dispatch/gate-context-builder.ts:12`
- Fix: Either remove the files (preferred) or update the deprecation notice to reflect the actual timeline.

**Gate Test Files Still Maintained:**
- Problem: Test files for the deprecated gate system still exist and presumably still run in CI, consuming test time for dead code:
  - `src/dispatch/__tests__/gate-evaluator.test.ts` (776 lines)
  - `src/dispatch/__tests__/gate-enforcement.test.ts` (542 lines)
  - `src/dispatch/__tests__/gate-conditional.test.ts` (~300 lines)
  - `src/dispatch/__tests__/gate-context-builder.test.ts`
  - `src/dispatch/__tests__/gate-timeout.test.ts`
  - `src/schemas/__tests__/gate.test.ts`
  - `src/schemas/__tests__/task-gate-extensions.test.ts`
- Files: Listed above, totaling ~2000+ lines of test code for deprecated functionality.
- Fix: Remove alongside the gate source files.

## Test Coverage Gaps

**Scheduler Concurrent Transition Safety:**
- What's not tested: The scheduler calls `store.transition()` directly without going through the task lock manager. No tests verify that two concurrent scheduler poll cycles cannot create conflicting transitions.
- Files: `src/dispatch/action-executor.ts`, `src/dispatch/assign-executor.ts`
- Risk: Double-dispatch of same task, or conflicting status transitions under load.
- Priority: Medium (single-process Node.js makes true concurrency rare, but async interleaving is possible).

**Stats Accuracy with Terminal States:**
- What's not tested: No test verifies that `PollResult.stats` correctly accounts for `cancelled` and `deadletter` tasks.
- Files: `src/dispatch/scheduler-helpers.ts` (buildTaskStats), `src/dispatch/scheduler.ts` (poll)
- Risk: Monitoring dashboards consuming PollResult stats will show incorrect task counts.
- Priority: Low (cosmetic, but could lead to incorrect alerting).

**Gate Timeout Code Path Under DAG-Only Regime:**
- What's not tested: `checkGateTimeouts()` runs on every scheduler poll but should never find gate-format tasks post-migration. No test verifies it's a safe no-op.
- Files: `src/dispatch/escalation.ts` lines 169-229
- Risk: Wasted I/O per poll cycle; if it does fire unexpectedly, it mutates task state without the task lock manager.
- Priority: Medium (remove with gate cleanup).

---

*Concerns audit: 2026-03-12*
