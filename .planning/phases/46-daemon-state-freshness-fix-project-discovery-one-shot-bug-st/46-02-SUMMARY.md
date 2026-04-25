---
phase: 46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st
plan: 02
subsystem: store
tags: [task-store, reconciliation, deadletter, drift-recovery, init, lintTasks]

# Dependency graph
requires:
  - phase: 46
    provides: Plan 01 — atomic transitionToDeadletter (closes the future-drift window so on-disk reconciliation only has to clean up legacy + escapee drift)
provides:
  - FilesystemTaskStore.init() heals on-disk drift between frontmatter.status and directory location on every fresh store construction
  - reconcileDrift() reuses the existing lintTasks walk; filters on the "Status mismatch:" issue prefix; renames .md to the matching status directory; best-effort companion-dir rename alongside
  - Defense-in-depth completion of Bug 1A: combined with Plan 01, future drift is prevented and existing drift heals on next daemon restart
affects:
  - Phase 46 Plan 03 onward — every project store init() now runs reconciliation; downstream plans should not assume the on-disk layout is untouched on boot
  - Future v1.18+ deploys — the user's 2026-04-24 ghost-task incident becomes invisible (auto-heal) instead of a 5-file hand-mitigation event

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "lintTasks-as-walk-source: a private mutation pass at init() reuses the read-only lintTasks() walk and acts on the issue prefix it already produces — no second filesystem walk, no STATUS_DIRS triplication"
    - "reconcile bypasses transition()/isValidTransition(): boot-time drift recovery trusts frontmatter.status as authoritative, so it does NOT route through store.transition() (which would re-run isValidTransition and reject otherwise-illegal terminal moves)"

key-files:
  created:
    - "src/store/__tests__/bug-046a-startup-reconciliation.test.ts — regression suite (3 test cases) pinning the self-heal behavior"
  modified:
    - "src/store/task-store.ts — init() calls new private reconcileDrift() after the status-dir mkdir loop; reconcileDrift() walks lintTasks issues, renames misfiled .md to the status dir matching frontmatter.status, best-effort renames the companion directory alongside"

key-decisions:
  - "Reconciliation runs at init() only, NOT per poll — explicit CONTEXT.md decision (it's a self-heal pass for past drift, not a continuous correction loop)"
  - "Reconciliation bypasses store.transition() — boot is the unique window where the per-task mutex makes no sense (no concurrent traffic) and where isValidTransition()'s rules would block otherwise-correct moves like ready→deadletter"
  - "frontmatter.status NOT in STATUS_DIRS → log warn + leave file in place (no delete, no guess) — T-46-02-01 path-traversal mitigation"
  - "Companion-dir rename is best-effort with ENOENT silently swallowed — most failure-tracker tasks have no companion dir, and a leftover empty dir is non-fatal (.md move is the critical half)"
  - "currentStatus derived by regex on the lintTasks 'Status mismatch:' issue string (T-46-02-05) — brittle but documented; fallback if format changes is to parse from oldPath"
  - "Deferred Q3 (duplicate-file detection at init): get()'s mtime-wins self-heal already covers same-task-ID-in-two-dirs; per-task locking landed in v1.14.8 so pre-v1.14.8 duplicates are unlikely on production installs; revisit as Phase 47 backlog item if observed in the wild"

patterns-established:
  - "Boot-time self-heal as the third defensive layer: (1) per-task mutex prevents intra-process drift, (2) atomic transitionToDeadletter prevents future split-state crashes, (3) reconcileDrift() heals any drift that survived (1)+(2)"
  - "Test plant pattern reuse: task-store-duplicate-recovery.test.ts:50-80 createAndPlantDuplicate is the canonical 'create + rm + writeFile' fixture for misfiled-task scenarios; bug-046a-startup-reconciliation.test.ts uses the same pattern for status-mismatch fixtures"

requirements-completed:
  - BUG-046-1A-RECONCILE

# Metrics
duration: 4min
completed: 2026-04-25
---

# Phase 46 Plan 02: Startup Reconciliation Summary

**FilesystemTaskStore.init() now heals on-disk drift between `frontmatter.status` and directory location via a new private `reconcileDrift()` pass that reuses the existing `lintTasks` walk — completing the defense-in-depth half of Bug 1A.**

## Performance

- **Duration:** 4 min (≈3m 40s)
- **Started:** 2026-04-25T15:52:10Z
- **Completed:** 2026-04-25T15:55:50Z
- **Tasks:** 2 (RED + GREEN)
- **Files modified:** 2 (1 new test, 1 source edit)

## Accomplishments

- New private `reconcileDrift()` method on `FilesystemTaskStore`, called from `init()` after the existing status-dir mkdir loop. Inserts at `src/store/task-store.ts:153` (call) and `:186` (method definition).
- Reuses `this.lint()` → `lintTasks()` (already in tree at `src/store/task-validation.ts:96-102`) — no second filesystem walk, no `STATUS_DIRS` triplication. Filters on the existing `"Status mismatch:"` issue prefix.
- Companion directory renamed alongside on a best-effort basis (`tasks/<old>/<id>/` → `tasks/<new>/<id>/`); ENOENT silently swallowed since most failure-tracker tasks have no companion dir at all.
- `STATUS_DIRS.includes(targetStatus)` allowlist guards the rename target — frontmatter values not in the set log a warn and leave the file in place (T-46-02-01 path-traversal mitigation).
- Idempotent on a drift-free store: a second `init()` finds no `Status mismatch:` issues and is a no-op (verified via `mtime` equality check in the regression test).
- Per-file try/catch around the rename block: one bad file does not abort the rest of `init()`.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — failing regression for startup reconciliation** — `160d493` (test)
2. **Task 2: GREEN — implement reconcileDrift() on FilesystemTaskStore.init()** — `ab6f4bd` (fix)

_Note: TDD plan; RED → GREEN sequence preserved as required by the plan's `tdd="true"` task type._

## Files Created/Modified

- **Created:** `src/store/__tests__/bug-046a-startup-reconciliation.test.ts` — 3 test cases covering the primary mismatch (`ready/` planted file with `frontmatter.status: deadletter` moves to `tasks/deadletter/`), idempotency on a drift-free store (two re-inits leave `mtime` unchanged), and companion-directory movement alongside the .md.
- **Modified:** `src/store/task-store.ts` — `init()` calls `await this.reconcileDrift()` after the mkdir loop; new `private async reconcileDrift(): Promise<void>` method.

## Decisions Made

- **Bypassing `store.transition()`**: reconciliation is a boot-time direct rename, NOT a `store.transition()` call. Rationale documented inline:
  - Boot is the unique no-concurrent-traffic window where the per-task mutex serves no purpose.
  - `isValidTransition()` would reject otherwise-correct moves (e.g. `ready` → `deadletter` is normally invalid except via specific failure paths). The contract for reconciliation is "trust the frontmatter — make on-disk match," not "re-run transition rules."
  - Regression test `Phase 46 / Bug 1A — startup reconciliation > moves a file with frontmatter.status=deadletter but in tasks/ready/ to tasks/deadletter/` enforces the bypass — if a future invariant change makes it incompatible with `isValidTransition`, the test will fail and force re-evaluation.
- **`currentStatus` regex extraction (T-46-02-05)**: brittle by design and documented inline. The regex `/but file in '(\w[\w-]*)\/'/` parses the lintTasks issue string. If `task-validation.ts` ever changes the format, the parse degrades to `undefined` and companion-dir rename is silently skipped — the .md still moves correctly, no data loss. Alternative (parse from `oldPath`) noted in the code comment for future refactoring.
- **Q3 deferral confirmed**: duplicate-file detection at `init()` (RESEARCH.md Open Question 3) deliberately NOT added. `get()`'s mtime-wins self-heal already covers same-task-ID-in-two-dirs at runtime; per-task locking landed in v1.14.8 so pre-v1.14.8 duplicates are unlikely on production installs. Phase 47 backlog item if observed post-v1.17.

## Deviations from Plan

None — plan executed exactly as written. The single nuance (`currentStatus` extraction now also intersects with `STATUS_DIRS` to avoid passing a non-`TaskStatus` literal into `taskDir()`) is a faithful implementation of the threat model in the plan, not a deviation.

## Issues Encountered

None. RED step produced 2 of 3 expected failures (the well-placed-file idempotency test passed under RED because no reconciliation was needed for that fixture — the planted file simply matched its directory). GREEN step turned all 3 cases green on the first run, with no test churn.

## User Setup Required

None — pure code change, no env vars, no config knobs, no external services.

## Verification Results

| Check | Result |
| --- | --- |
| `./scripts/test-lock.sh run src/store/__tests__/bug-046a-startup-reconciliation.test.ts` | ✓ 3 / 3 passed |
| `./scripts/test-lock.sh run src/store/__tests__/` (full store suite) | ✓ 192 / 192 passed across 17 files |
| `./scripts/test-lock.sh run src/service/__tests__/` (multi-project init path) | ✓ 42 / 42 passed across 5 files |
| `./scripts/test-lock.sh run src/store/__tests__/task-store-duplicate-recovery.test.ts` (no regression in get() self-heal) | ✓ 5 / 5 passed |
| `npm run typecheck` | ✓ clean (no errors) |
| `npx madge --circular --extensions ts src/` | ✓ "No circular dependency found!" |

## Threat Surface Scan

No new external surface introduced. The reconcileDrift() method only operates on paths under `tasksDir` and the `STATUS_DIRS` allowlist guards every rename target. All threats are documented in the plan's `<threat_model>` (T-46-02-01..05). No additional threat flags.

## Next Phase Readiness

- Bug 1A is fully closed: Plan 01 (atomic transition) prevents future split-state crashes; Plan 02 (this) heals any drift that already exists on disk.
- Plan 03 onward (project rediscovery, log rotation, routing validation, actor injection) is independent of this work and proceeds as planned.
- The user's 2026-04-24 5-ghost-task incident becomes invisible on the next daemon restart after deploy: the misfiled files would auto-move to `tasks/deadletter/` without operator intervention.

## Self-Check: PASSED

- File `.planning/phases/46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st/46-02-SUMMARY.md` (this file): pending commit (will exist after final commit step).
- File `src/store/__tests__/bug-046a-startup-reconciliation.test.ts`: present in commit `160d493`.
- File `src/store/task-store.ts` (modified): present in commit `ab6f4bd`.
- Commit `160d493` (test(46-02) RED): present in `git log`.
- Commit `ab6f4bd` (fix(46-02) GREEN): present in `git log`.
- Plan-level TDD gate sequence (RED → GREEN): satisfied. `test(...)` commit precedes `fix(...)` commit. No REFACTOR commit (none required — implementation matches PATTERNS.md skeleton verbatim with documented threat-model hardening).

---
*Phase: 46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st*
*Plan: 02*
*Completed: 2026-04-25*
