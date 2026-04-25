---
phase: 46-daemon-state-freshness
plan: 05
subsystem: tools
tags: [aof_dispatch, routing, validation, project-manifest, sentinel, tdd]

requires:
  - phase: 44-daemon-state-freshness-prelude
    provides: BUG-044 unscoped-store handling in loadProjectManifest (returns null for unscoped or falsy projectId)
provides:
  - aof_dispatch rejects empty-routing tasks at create-time with a named error (BUG-046d)
  - Project-owner-based routing default (input.project ?? ctx.projectId → manifest.owner.lead → routing.agent, fallback owner.team → routing.team)
  - Case-insensitive 'system' sentinel skip — does NOT default from placeholder owners (CONTEXT.md addendum Q3)
  - 8-case regression suite locking in routing-required behavior + sentinel handling
affects: [46-06, future tools/* additions, agent guidance, MCP tool catalog]

tech-stack:
  added: []
  patterns:
    - "Handler-level (not Zod) validation for cross-store reads (loadProjectManifest); pattern matches existing dependsOn validation in same file"
    - "Defaulting + sentinel skip pattern: try project-owner default, fall through to rejection if defaulted value is sentinel or absent"

key-files:
  created:
    - src/tools/__tests__/bug-046d-routing-required.test.ts
    - .planning/phases/46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st/deferred-items.md
  modified:
    - src/tools/project-tools.ts
    - src/tools/__tests__/aof-dispatch-dependson-validation.test.ts
    - src/tools/__tests__/aof-dispatch-timeout.test.ts
    - src/tools/__tests__/aof-tools-events.test.ts
    - src/tools/__tests__/aof-tools-persistence.test.ts
    - src/tools/__tests__/task-seeder.test.ts
    - src/integration/__tests__/bug-005-tool-persistence.test.ts

key-decisions:
  - "Routing validation lives in the handler, not in dispatchSchema (Zod): loadProjectManifest is async and store-bound, only the handler can call it. Mirrors the existing handler-level dependsOn validation pattern in the same file."
  - "Validation order: brief-required → routing-required → dependsOn-references-exist → notifyOnCompletion-shape → ctx.store.create. Routing comes BEFORE dependsOn so a tags-only task fails fast on the most fundamental gap."
  - "'system' sentinel is matched case-insensitively (.toLowerCase() !== 'system'). Defends against a caller crafting owner.team='SYSTEM' to bypass the sentinel skip (T-46-05-05 in threat register)."
  - "When defaulting fires, owner.lead takes precedence over owner.team — agent-level routing is more specific than team-level. If lead is 'system' (skipped), team is tried next."
  - "AOFDispatchInput TS interface gained an explicit `project?: string` field to mirror dispatchSchema. Previously implicit via the Zod schema; now needed because the handler reads input.project directly."

patterns-established:
  - "Pattern: Handler-level project-manifest defaulting — try input.project ?? ctx.projectId, loadProjectManifest, default specific fields, sentinel-skip placeholder values, then fall through to rejection."
  - "Pattern: Sentinel value handling — case-insensitive comparison via .toLowerCase(), to prevent case-permutation bypass."

requirements-completed:
  - BUG-046-2B

duration: 12min
completed: 2026-04-25
---

# Phase 46 Plan 05: Routing Validation at Task Creation Summary

**aof_dispatch now rejects empty-routing tasks at create-time with a named error and defaults from project.owner.{lead,team} when set, treating 'system' as a case-insensitive sentinel for "no real owner — do not default"**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-04-25T15:54:56Z
- **Completed:** 2026-04-25T16:06:58Z
- **Tasks:** 2 (TDD: RED + GREEN)
- **Files created:** 2 (1 test, 1 deferred-items doc)
- **Files modified:** 7 (1 source, 6 tests)

## Accomplishments

- Closed BUG-046-2B (Bug 2B in the 2026-04-24 daemon-state-and-resource-hygiene incident): an aof_dispatch with no agent/team/role no longer sits silently in `tasks/ready/` for 21+ minutes — it returns a clear error with remediation guidance ("Provide one of: agent, team, role").
- Wired project-owner-based defaulting so an agent dispatching a task within their own project doesn't have to repeat the routing every time. Defaults from `input.project ?? ctx.projectId` via `loadProjectManifest`.
- Hardened the `'system'` placeholder owner case (locked in by CONTEXT.md addendum Q3): a project with `owner: { team: "system", lead: "system" }` (the `_inbox` placeholder, the `event-calendar-2026` failing project from the incident) does NOT default routing — it falls through to rejection. Sentinel match is case-insensitive (`.toLowerCase() !== "system"`) so a caller crafting `owner.team = "SYSTEM"` cannot bypass the skip (threat T-46-05-05).
- 8-case regression suite (`bug-046d-routing-required.test.ts`): empty-routing rejection, no-file-on-reject, lead-default, team-default-when-lead-system, both-system-sentinel, uppercase-sentinel, role-only baseline, explicit-agent baseline.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — failing regression for routing validation** — `edd35f6` (test)
2. **Task 2: GREEN — implement routing validation + project-owner defaulting** — `30fdf2d` (fix)

_TDD: RED commit (8 cases, 6 failing) → GREEN commit (8 cases passing + handler change + 6 affected pre-existing test files updated)_

## Files Created/Modified

### Created
- `src/tools/__tests__/bug-046d-routing-required.test.ts` — 8-case regression suite under `describe("Phase 46 / Bug 2B — routing required at create time", ...)`. Uses `buildProjectManifest` + `writeProjectManifest` to construct project-scoped stores for the defaulting cases.
- `.planning/phases/46-.../deferred-items.md` — logs pre-existing CLI subprocess test failures (`memory-cli.test.ts`, `org-drift-cli.test.ts`) confirmed unrelated to this change. Out-of-scope per CLAUDE.md scope-boundary rule.

### Modified
- `src/tools/project-tools.ts` (the only source change):
  - Added `import { loadProjectManifest } from "../projects/manifest.js";`
  - Added `project?: string` to `AOFDispatchInput` interface (mirrors `dispatchSchema.project`).
  - Inserted routing-validation block between brief validation and `dependsOn` validation: 3-branch logic (try explicit → try project-owner default → reject).
  - Updated `ctx.store.create` `routing` literal from `{ agent: input.agent, team: input.team, role: input.role }` to `{ agent, team, role }` so the (possibly defaulted) locals land in frontmatter.

### Tests updated to pass explicit routing (none of these tested empty-routing acceptance intentionally)
- `src/tools/__tests__/aof-dispatch-dependson-validation.test.ts` — 5 cases gained `agent: "main"` so they exercise dependsOn validation specifically (not the new routing gate).
- `src/tools/__tests__/aof-dispatch-timeout.test.ts` — 3 handler-invoking cases gained `agent: "main"`.
- `src/tools/__tests__/aof-tools-events.test.ts` — 6 dispatch sites gained `agent: "test-agent"`.
- `src/tools/__tests__/aof-tools-persistence.test.ts` — 11 dispatch sites gained `agent: "test-actor"`.
- `src/tools/__tests__/task-seeder.test.ts` — 9 seed-entry sites (programmatic, YAML, JSON, edge cases) gained `agent: "test-agent"`.
- `src/integration/__tests__/bug-005-tool-persistence.test.ts` — 8 dispatch sites gained `agent: "test-agent"`. The empty-title and empty-brief test cases were left as-is — title/brief validation runs before routing validation, so those cases still hit their original error.

## Decisions Made

- **Validation lives in the handler, not in Zod.** `loadProjectManifest` is async and store-bound. Mirrors the existing dependsOn validation in the same handler.
- **Validation ordering: brief → routing → dependsOn → notifyOnCompletion-shape → ctx.store.create.** Verified by `awk` script in acceptance criteria: `b<r && r<d`.
- **Case-insensitive sentinel via `.toLowerCase() !== "system"`.** Defends T-46-05-05 from the threat register; locked in by an explicit uppercase test case.
- **`AOFDispatchInput` gained explicit `project?: string`.** The Zod schema already had it but the TS interface didn't; the typecheck error surfaced this gap immediately.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Added `project?: string` to AOFDispatchInput TS interface**
- **Found during:** Task 2 (GREEN — typecheck after the source edit)
- **Issue:** `tsc --noEmit` reported `error TS2339: Property 'project' does not exist on type 'AOFDispatchInput'` at `src/tools/project-tools.ts:190:29`. The plan instructed reading `input.project ?? ctx.projectId`, but the TS interface didn't declare `project` (the Zod schema did at line 32 — schema/interface drift).
- **Fix:** Added `project?: string` to `AOFDispatchInput` (mirrors `dispatchSchema.project`). Doc-comment notes the Phase 46 / Bug 2B context and that this brings the TS interface in line with the schema.
- **Files modified:** `src/tools/project-tools.ts`
- **Verification:** `npm run typecheck` clean.
- **Committed in:** `30fdf2d` (Task 2 commit).

**2. [Rule 3 — Blocking] Updated 6 pre-existing test files that called aofDispatch without explicit routing**
- **Found during:** Task 2 (GREEN — tools test suite run after source edit)
- **Issue:** 4 test files in `src/tools/__tests__/` plus `src/integration/__tests__/bug-005-tool-persistence.test.ts` plus `src/tools/__tests__/task-seeder.test.ts` (via the seeder) all relied on the previously-undefined behavior of `aofDispatch` accepting empty routing. With routing now required, those tests started failing with the new "requires a routing target" error.
- **Fix:** Added explicit `agent: "test-agent"` (or equivalent test-scoped value) to each affected dispatch site. The plan's `<action>` block predicted this would be needed and instructed updating any pre-existing test relying on undefined behavior — categorized as auto-fix Rule 3 because the Phase 46 source change directly causes the test failures.
- **Files modified:** 6 test files (see "Modified" list above).
- **Verification:** Full `src/tools/__tests__/` suite + `bug-005-tool-persistence.test.ts` = 153 tests pass.
- **Committed in:** `30fdf2d` (Task 2 commit).

**3. [Rule 4 — Out of scope, logged for follow-up] Pre-existing CLI subprocess test failures**
- **Found during:** Task 2 verification (full unit-test suite run)
- **Issue:** `src/commands/__tests__/memory-cli.test.ts` (11 failures) and `src/commands/__tests__/org-drift-cli.test.ts` (6 failures). These tests use `execSync` against `dist/cli/index.js`, which doesn't exist in a fresh worktree (no `npm run build`). Confirmed pre-existing on the branch base via `git stash` test — failures reproduce identically without my changes.
- **Action:** NOT auto-fixed (out of scope — neither caused by nor in the same subsystem as Phase 46 / Bug 2B). Logged to `.planning/phases/46-.../deferred-items.md` per CLAUDE.md scope-boundary rule.
- **Files modified:** none (logging only).
- **Committed in:** `30fdf2d` (deferred-items.md included alongside Task 2 commit).

---

**Total deviations:** 2 auto-fixed (Rule 3 ×2) + 1 logged out-of-scope.
**Impact on plan:** Both Rule-3 fixes were anticipated by the plan's `<action>` block. The TS interface gap (`AOFDispatchInput.project?: string`) is a small ergonomic improvement worth keeping. No scope creep.

## Issues Encountered

None outside the deviations documented above. The plan's structural template (the existing dependsOn validation block) translated cleanly into the new routing validation block.

## Verification Snapshot

```text
$ ./scripts/test-lock.sh run src/tools/__tests__/bug-046d-routing-required.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)

$ ./scripts/test-lock.sh run src/tools/__tests__/ src/integration/__tests__/bug-005-tool-persistence.test.ts
 Test Files  17 passed (17)
      Tests  153 passed (153)

$ npm run typecheck
(clean — exit 0)

$ npx madge --circular --extensions ts src/
✔ No circular dependency found!

$ grep -c "Tags-only routing is not supported" src/tools/project-tools.ts
1

$ grep -c '.toLowerCase() !== "system"' src/tools/project-tools.ts
2

$ grep -c "routing: { agent, team, role }" src/tools/project-tools.ts
1

$ awk '/brief.*required/{b=NR} /requires a routing target/{r=NR} /dependsOn references nonexistent/{d=NR} END{print (b<r && r<d)}' src/tools/project-tools.ts
1
```

## User Setup Required

None — this is a pure code-side validation change. No new env vars, no migration, no manifest format change. Existing projects with `owner: { team: "system", lead: "system" }` (e.g. the `_inbox` placeholder) continue to work; tasks dispatched into them with no explicit routing now fail fast with a clear error instead of stranding silently.

## Cross-references

- **CONTEXT.md addendum Q3** (lines 363-390): "treat `system` as a sentinel meaning 'no real owner team / lead'" — the source-of-truth decision this plan implements.
- **PATTERNS.md** (lines 490-610): the structural template for the new validation block (dependsOn validation pattern + the post-Phase-46 aofDispatch shape).
- **`src/dispatch/task-dispatcher.ts:191-250`**: the downstream "task has tags-only routing (not supported)" rejection that motivated this change. With Plan 46-05 in place, that branch should now only fire on tasks whose routing was wiped post-create — the create-time path can no longer produce a tags-only task.
- **Phase 46 / Bug 2B (BUG-046-2B)**: the requirement closed by this plan.

## Next Phase Readiness

- Plan 46-05 is independent of the other Wave-1 plans (46-01 through 46-04, 46-06). Worktree commits sit cleanly on top of `989e79f` (the Phase 46 planning-complete commit).
- No follow-up work in Phase 46 depends on this plan.
- The `deferred-items.md` log captures pre-existing CLI test failures for a future maintenance phase.

## Self-Check: PASSED

Verified before SUMMARY commit:
- `src/tools/__tests__/bug-046d-routing-required.test.ts` — FOUND
- `.planning/phases/46-.../deferred-items.md` — FOUND
- `.planning/phases/46-.../46-05-SUMMARY.md` — FOUND (this file)
- Commit `edd35f6` (test RED) — FOUND in `git log`
- Commit `30fdf2d` (fix GREEN) — FOUND in `git log`

---
*Phase: 46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st*
*Plan: 05*
*Completed: 2026-04-25*
