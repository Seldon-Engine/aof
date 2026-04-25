---
phase: 46
plan: 01
subsystem: dispatch + store
tags: [bugfix, atomicity, deadletter, BUG-046a]
requires:
  - "src/store/task-mutations.ts:transitionTask (existing)"
  - "src/store/interfaces.ts:ITaskStore.transition (existing)"
  - "src/dispatch/failure-tracker.ts:transitionToDeadletter (existing)"
  - "src/store/task-lock.ts:TaskLocks (existing per-task mutex)"
provides:
  - "ITaskStore.transition opts.metadataPatch — atomic frontmatter.metadata patch applied with the rename"
  - "TransitionOpts.metadataPatch — internal interface for transitionTask"
  - "transitionToDeadletter — single-call, atomic stamp+rename (no observable store.save() in this path)"
affects:
  - "src/store/interfaces.ts (additive opts shape change)"
  - "src/store/task-mutations.ts (TransitionOpts extension + 1 new code block in transitionTask)"
  - "src/dispatch/failure-tracker.ts (call-site collapsed; trackDispatchFailure + resetDispatchFailures untouched)"
  - "src/dispatch/__tests__/bug-046a-atomic-transition.test.ts (new — 3 regression cases)"
tech-stack:
  added: []
  patterns:
    - "metadataPatch: atomic-with-rename frontmatter merge inside the existing TaskLocks per-task critical section"
    - "module-level vi.mock(\"node:fs/promises\") with per-test override for fault-injecting rename — necessary because task-mutations.ts uses NAMED imports (rename, unlink, mkdir, stat) that bind statically and are not interceptable via vi.spyOn on the namespace"
key-files:
  created:
    - "src/dispatch/__tests__/bug-046a-atomic-transition.test.ts"
  modified:
    - "src/store/interfaces.ts"
    - "src/store/task-mutations.ts"
    - "src/dispatch/failure-tracker.ts"
decisions:
  - "Apply metadataPatch BEFORE the writeFileAtomic at the new location, not after, so the new-location file lands with patched frontmatter on first write — no second write ever needed and no risk of a midway crash leaving an unpatched new file"
  - "Idempotent transition early-return at task-mutations.ts:151 deliberately skips the patch — failure-tracker only reaches transitionToDeadletter for non-no-op transitions, documented inline"
  - "Preserve existing TransitionOpts vs ITaskStore.transition opts drift (interfaces.ts has blockers?: string[], task-mutations.ts does not) — out of scope per PATTERNS.md cross-cutting concern #1"
  - "Leave trackDispatchFailure and resetDispatchFailures untouched — they use store.save() for metadata-only writes and have no split-state bug"
  - "Test the rollback invariant by fault-injecting the COMPANION-DIR rename (the .md hits disk via writeFileAtomic, not rename), exercising the existing post-6fbcb18 unlink-rollback path at task-mutations.ts:200-211"
metrics:
  duration: "~12 minutes (Task 1 RED → Task 3 fix)"
  completed: "2026-04-25T16:03:24Z"
  commits: 3
  files_changed: 4
  lines_added: 277
  lines_removed: 19
---

# Phase 46 Plan 01: Atomic save+transition (Bug 1A) Summary

Bug 1A — `transitionToDeadletter` no longer does `save() + transition()` as two
separate awaits. The frontmatter stamp and the file move now happen inside one
atomic critical section, eliminating the partial-state window that caused the
2026-04-24 incident (5 ghost tasks in `tasks/ready/` with `frontmatter.status:
deadletter`, scheduler spin-looping at full throttle, 172 MB log file).

## What changed

### `src/store/interfaces.ts`

`ITaskStore.transition`'s opts type gained a fourth field:

```ts
opts?: {
  reason?: string;
  agent?: string;
  blockers?: string[];
  metadataPatch?: Record<string, unknown>;
};
```

Additive change. Existing callers (no opts; `{ reason }`; `{ reason, agent }`)
compile unchanged. The `blockers?: string[]` drift between this type and the
internal `TransitionOpts` is preserved (out of scope).

### `src/store/task-mutations.ts`

`TransitionOpts` gained the matching `metadataPatch?: Record<string, unknown>`
field. Inside `transitionTask`, between the `lastTransitionAt` assignment and
the lease-clearing branch, the patch is applied:

```ts
if (opts?.metadataPatch) {
  task.frontmatter.metadata = {
    ...task.frontmatter.metadata,
    ...opts.metadataPatch,
  };
}
```

Critically, this runs BEFORE the new-location `writeFileAtomic(newPath,
serializeTask(task))` (line 219 in the post-6fbcb18 write-new-then-delete-old
path; line 254 on the same-location branch). The patched frontmatter lands on
disk on first write — a midway crash cannot leave an unpatched new file.

### `src/dispatch/failure-tracker.ts` — before/after

**Before** (the bug):

```ts
task.frontmatter.metadata = {
  ...task.frontmatter.metadata,
  deadletterReason,
  deadletterLastError: lastFailureReason,
  deadletterErrorClass: errorClass,
  deadletterAt: deadletteredAt,
  deadletterFailureCount: failureCount,
};
await store.save(task);                            // step 1: stamp
await store.transition(taskId, "deadletter");      // step 2: move — split-state window between these
```

**After**:

```ts
await store.transition(taskId, "deadletter", {
  reason: deadletterReason,
  metadataPatch: {
    deadletterReason,
    deadletterLastError: lastFailureReason,
    deadletterErrorClass: errorClass,
    deadletterAt: deadletteredAt,
    deadletterFailureCount: failureCount,
  },
});
```

`trackDispatchFailure` and `resetDispatchFailures` (also in this file) still
call `store.save()` — those are metadata-only writes, never move files, never
had the split-state bug. Untouched. The post-transition
`eventLogger.log("task.deadlettered", ...)` and `log.error` ops alert at the
end of `transitionToDeadletter` are also untouched — audit trail preserved.

### `src/dispatch/__tests__/bug-046a-atomic-transition.test.ts` (new)

Three regression cases under `describe("Phase 46 / Bug 1A — atomic
transitionToDeadletter", ...)`:

1. **stamps deadletter metadata AND moves file to deadletter/ in a single
   atomic operation** — happy-path baseline. Reads the resulting file directly
   from `tasks/deadletter/<id>.md` (bypassing the store's mtime-wins self-heal)
   and asserts all five `deadletter*` frontmatter fields are present along with
   `status: deadletter`, plus the original `tasks/blocked/<id>.md` is gone.
2. **rollback: if rename fails, frontmatter status remains the original (NOT
   'deadletter')** — fault-injects the companion-dir rename via module-level
   `vi.mock("node:fs/promises")` (with a per-test override hook); because the
   test pre-creates a companion dir via `store.writeTaskOutput`, the
   transition's companion-dir `rename()` is actually attempted, throws, and
   the existing post-6fbcb18 unlink-rollback path fires — leaving the .md at
   its ORIGINAL `tasks/blocked/<id>.md` location with `status: blocked` and
   no `deadletter*` metadata fields. This pins the rollback invariant
   end-to-end through the failure-tracker.
3. **no separate save() call is observable in the failure-tracker code path**
   — wraps the store with a `Proxy` that counts calls to `save()` vs
   `transition()`; runs the happy path; asserts `saveCount === 0` and
   `transitionCount === 1`. Pins the architectural invariant: future
   regressions that re-introduce the split-write are caught at test time.

The mock strategy uses module-level `vi.mock` (not `vi.spyOn` on the
namespace) because `task-mutations.ts` imports `node:fs/promises` with NAMED
imports — the binding is resolved at module load and namespace spies don't
intercept it. This is documented inline in the test file.

## RED → GREEN trajectory

| Test                                                            | RED (Task 1) | After Task 2  | After Task 3  |
| --------------------------------------------------------------- | ------------ | ------------- | ------------- |
| atomic stamp+move (happy path)                                  | PASS\*       | PASS          | PASS          |
| rollback: failure leaves blocked file unmodified                | FAIL         | FAIL          | PASS          |
| no separate save() call observable                              | FAIL         | FAIL          | PASS          |

\*Test 1 already passed at RED because the v1.16.3 write-new-then-delete-old
hardening means the metadata-rich `task.frontmatter` (after `save()`) lands at
the new location on the next `transition()`'s first write. But under fault
injection (test 2), the pre-Plan-01 split-write left the `deadletter*`
metadata stamped on the ORIGINAL-location file via the `save()` step —
exactly the partial-state we're closing.

## Confirmation: BUG-005 + concurrent-transition tests stayed GREEN

- `src/dispatch/__tests__/deadletter-frontmatter-stamp.test.ts` — 3/3 PASS
- `src/dispatch/__tests__/deadletter-integration.test.ts` — 5/5 PASS
- `src/dispatch/__tests__/deadletter.test.ts` — 9/9 PASS
- `src/store/__tests__/task-store-concurrent-transition.test.ts` — 4/4 PASS

Full `src/dispatch/__tests__/` sweep: 597/597 PASS.

## Threat surface

The plan's `<threat_model>` declared T-46-01-04 (audit-trail repudiation if
removing `save()` removes a discrete audit event) as a `mitigate` disposition
— mitigation was preserving the
`eventLogger.log("task.deadlettered", "system", { ... })` block at lines
107-126 untouched. Verified: `git diff` shows no change in that block. The
event logger still records the full failure chain to `events.jsonl` with
`actor: "system"`. Audit trail preserved.

T-46-01-01 (Tampering — future caller spreading arbitrary keys via
`metadataPatch`) was accepted with low risk: `metadataPatch` is internal-only,
not exposed via any IPC/MCP/Zod wire contract, and documented in JSDoc with
"only failure-tracker uses it." Threat register entry remains accepted.

T-46-01-02 (DoS — slightly longer mutex hold per transition) and T-46-01-03
(Information Disclosure — error path leaks paths) were both accepted as
negligible/unchanged.

## Deviations from Plan

**None.** Plan executed exactly as written. The three commits land in the
prescribed order: `test(46-01)` (RED) → `feat(46-01)` (interface + mutation)
→ `fix(46-01)` (call-site collapse). Test cases match the plan's prescribed
naming and structure verbatim.

## Deferred Issues

**Out-of-scope pre-existing test failures (logged, not fixed):** running
`./scripts/test-lock.sh run` (full unit suite) reports 17 pre-existing
failures across 2 CLI test files:

- `src/commands/__tests__/memory-cli.test.ts` — 11 failures
- `src/commands/__tests__/org-drift-cli.test.ts` — 6 failures

Root cause: both spawn the AOF CLI as a subprocess from
`dist/cli/index.js`, but the worktree clone does not contain `dist/`
(Cannot find module `dist/cli/index.js`). Confirmed pre-existing by stashing
this plan's changes and re-running the same files at HEAD~1 (still 11/11
fail in `memory-cli.test.ts`). Unrelated to Plan 01 surface area
(`failure-tracker.ts`, `task-mutations.ts`, `interfaces.ts`); their CLI code
paths are untouched. Deferred — these are a worktree-build-state issue that
should be addressed by either gating the CLI tests on `dist/` presence or
running `npm run build` as part of `test-lock.sh`.

## Auth gates

None encountered. No external services involved in this plan.

## Plan-02 connection

Plan 02 (startup reconciliation, Bug 1B in the original brief — separate
plan in this phase, see `46-02-PLAN.md`) is the defense-in-depth complement
to Plan 01:

- **Plan 01** (this plan) prevents future drift by making
  `transitionToDeadletter` atomic — the partial-state window is structurally
  closed for new transitions.
- **Plan 02** heals existing on-disk drift at startup — sweeps tasks with
  mismatched directory-vs-frontmatter status and reconciles them, recovering
  any pre-existing ghosts left over from before this fix landed.

Both ship in Phase 46. Together, they close the spin-loop class of bugs
identified in the 2026-04-24 incident postmortem.

## Self-Check: PASSED

- FOUND: `src/dispatch/__tests__/bug-046a-atomic-transition.test.ts`
- FOUND: `src/store/interfaces.ts` (modified — `metadataPatch` present)
- FOUND: `src/store/task-mutations.ts` (modified — `metadataPatch` in `TransitionOpts` and `transitionTask` body)
- FOUND: `src/dispatch/failure-tracker.ts` (modified — single `transition` call with `metadataPatch`, no `save() + transition()` split)
- FOUND: commit `8db8a7c` (test/RED)
- FOUND: commit `7de2633` (feat/interface+mutation)
- FOUND: commit `a5546d7` (fix/call-site collapse)
