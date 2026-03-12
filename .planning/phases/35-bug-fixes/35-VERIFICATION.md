---
phase: 35-bug-fixes
verified: 2026-03-12T17:35:00Z
status: passed
score: 6/6 must-haves verified
re_verification: false
---

# Phase 35: Bug Fixes Verification Report

**Phase Goal:** Known correctness bugs fixed — task statistics accurate, daemon timing correct, type definitions clean, race conditions mitigated
**Verified:** 2026-03-12T17:35:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                          | Status     | Evidence                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | buildTaskStats returns cancelled and deadletter counts, preventing false 'all tasks blocked' alerts | VERIFIED | `scheduler-helpers.ts:22-23` has both fields; loop at lines 34-35 increments them                        |
| 2   | Daemon startTime reflects actual startAofDaemon() call, not module import time                 | VERIFIED   | `daemon.ts:44` — `const startTime = Date.now()` is line 1 inside `startAofDaemon()`, not at module scope |
| 3   | UpdatePatch and TransitionOpts have no blockers field                                          | VERIFIED   | `task-mutations.ts` — grep for "blockers" returns zero hits                                               |
| 4   | Scheduler-initiated acquireLease and store.transition calls are wrapped in lockManager.withLock | VERIFIED  | `assign-executor.ts:513-514`; `action-executor.ts:150-151`                                                |
| 5   | Router and scheduler share the same TaskLockManager instance                                   | VERIFIED   | `aof-service.ts:107` creates one `InMemoryTaskLockManager`; passed to both `ProtocolRouter` (line 122) and `schedulerConfig` (line 134) |
| 6   | Concurrent protocol message + scheduler action on same task are serialized                     | VERIFIED   | `assign-executor.ts` wraps entire `executeAssignAction` body; `action-executor.ts` wraps `expire_lease` handler; 3 regression tests confirm |

**Score:** 6/6 truths verified

### Required Artifacts

| Artifact                                               | Expected                                                    | Status   | Details                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `src/dispatch/scheduler-helpers.ts`                    | buildTaskStats with cancelled + deadletter fields           | VERIFIED | Lines 22-23 add fields; lines 34-35 count them in loop                             |
| `src/dispatch/scheduler.ts`                            | PollResult.stats type with cancelled + deadletter; alert logic corrected | VERIFIED | Lines 101-102 add fields to PollResult.stats; line 477 subtracts both from activeTasks |
| `src/dispatch/__tests__/scheduler-helpers.test.ts`     | Regression test for buildTaskStats counting all 8 statuses | VERIFIED | File exists; tests at lines 34-35, 46-47, 63-64, 80-81 cover cancelled/deadletter; 22 tests pass |
| `src/daemon/daemon.ts`                                 | startTime inside startAofDaemon function scope              | VERIFIED | Line 44 is the first statement inside `startAofDaemon()`; uptime closure at line 100 captures it correctly |
| `src/store/task-mutations.ts`                          | Clean UpdatePatch and TransitionOpts without blockers       | VERIFIED | UpdatePatch (lines 14-24) and TransitionOpts (lines 109-112) — no blockers field present |
| `src/dispatch/scheduler.ts`                            | SchedulerConfig with optional lockManager field             | VERIFIED | Line 70: `lockManager?: TaskLockManager`                                           |
| `src/dispatch/action-executor.ts`                      | expire_lease handler wrapped in withLock                    | VERIFIED | Lines 150-151: `config.lockManager?.withLock(action.taskId, expireBody)`           |
| `src/dispatch/assign-executor.ts`                      | acquireLease and transition calls wrapped in withLock       | VERIFIED | Lines 513-514: entire executeAssignAction body wrapped via `config.lockManager.withLock` |
| `src/service/aof-service.ts`                           | Shared InMemoryTaskLockManager passed to both router and schedulerConfig | VERIFIED | Lines 107, 122, 134: single instance created and threaded through both |
| `src/dispatch/__tests__/assign-executor.test.ts`       | 3 lockManager integration tests                             | VERIFIED | `describe("assign-executor lockManager integration (BUG-04)")` at line 233; 3 tests all pass |

### Key Link Verification

| From                               | To                                   | Via                                              | Status   | Details                                                                  |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| `src/dispatch/scheduler-helpers.ts` | `src/dispatch/scheduler.ts`         | buildTaskStats return type consumed by PollResult.stats and alert logic | VERIFIED | `stats.cancelled` and `stats.deadletter` present in PollResult type and alert subtraction at line 477 |
| `src/service/aof-service.ts`        | `src/protocol/router.ts`            | lockManager passed in ProtocolRouter deps        | VERIFIED | `aof-service.ts:122` passes `lockManager` to ProtocolRouter constructor  |
| `src/service/aof-service.ts`        | `src/dispatch/scheduler.ts`         | lockManager in SchedulerConfig                   | VERIFIED | `aof-service.ts:134` sets `lockManager` on schedulerConfig              |
| `src/dispatch/assign-executor.ts`   | `src/protocol/task-lock.ts`         | withLock wrapping acquireLease and transition    | VERIFIED | Lines 513-514 use `config.lockManager.withLock`                          |

### Requirements Coverage

| Requirement | Source Plan | Description                                                              | Status    | Evidence                                                                                  |
| ----------- | ----------- | ------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------- |
| BUG-01      | Plan 01     | buildTaskStats counts cancelled and deadletter statuses                  | SATISFIED | `scheduler-helpers.ts:22-35`; `scheduler.ts:101-102,477`; regression test file passes    |
| BUG-02      | Plan 01     | Daemon startTime initialized inside startAofDaemon(), not at module load | SATISFIED | `daemon.ts:44`; daemon test BUG-02 regression at line 337 passes                         |
| BUG-03      | Plan 01     | UpdatePatch.blockers removed; TransitionOpts.blockers removed            | SATISFIED | `task-mutations.ts` — zero grep hits for "blockers"; `tsc --noEmit` clean                |
| BUG-04      | Plan 02     | TOCTOU race mitigated via shared TaskLockManager                         | SATISFIED | `aof-service.ts:107,122,134`; `assign-executor.ts:513-514`; `action-executor.ts:150-151`; 3 integration tests pass |

No orphaned requirements — all Phase 35 requirements (BUG-01 through BUG-04) are claimed by a plan and verified in the codebase.

### Anti-Patterns Found

| File              | Line | Pattern                                | Severity | Impact                                                        |
| ----------------- | ---- | -------------------------------------- | -------- | ------------------------------------------------------------- |
| `src/daemon/daemon.ts` | 108 | `// TODO: wire to actual provider count` | Info  | Pre-existing TODO unrelated to this phase's scope; providersConfigured hardcoded to 0 |

No blockers or warnings. The one TODO was present before this phase and is outside phase scope.

### Human Verification Required

None — all changes are logic fixes with full regression test coverage. TypeScript compilation is clean and all 22 new/modified tests pass.

### Gaps Summary

No gaps. All six observable truths are verified, all artifacts exist and are substantive, all key links are wired, and all four requirements are satisfied with test evidence.

---

_Verified: 2026-03-12T17:35:00Z_
_Verifier: Claude (gsd-verifier)_
