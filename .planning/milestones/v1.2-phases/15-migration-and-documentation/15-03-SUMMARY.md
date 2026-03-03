---
phase: 15-migration-and-documentation
plan: 03
subsystem: docs
tags: [documentation, dag-workflow, migration, deprecation, cli-reference]

requires:
  - phase: 15-02
    provides: "DAG documentation files (workflow-dags.md, workflow-dag-design.md) that we link to"
  - phase: 14-03
    provides: "--workflow CLI flag reflected in CLI reference"
provides:
  - "Companion skill rewritten for DAG workflows (agents use this for quick reference)"
  - "Gate terminology replaced with DAG/hop equivalents across all docs"
  - "Gate-to-DAG migration section in migration.md"
  - "Deprecation markers on 6 gate source files"
  - "Obsolete gate doc files deleted"
affects: []

tech-stack:
  added: []
  patterns: ["JSDoc @deprecated markers with @see pointing to DAG replacements"]

key-files:
  created: []
  modified:
    - skills/aof/SKILL.md
    - docs/guide/migration.md
    - docs/README.md
    - docs/guide/cli-reference.md
    - src/dispatch/gate-evaluator.ts
    - src/dispatch/gate-transition-handler.ts
    - src/dispatch/gate-context-builder.ts
    - src/dispatch/gate-conditional.ts
    - src/schemas/gate.ts
    - src/schemas/workflow.ts

key-decisions:
  - "Gate source files kept with @deprecated markers (remove in v1.3 per user decision)"
  - "OpenClaw gateway references preserved unchanged (gateway != workflow gate)"
  - "Root README.md also updated to fix broken link to deleted workflow-gates.md"

patterns-established:
  - "Deprecation pattern: @deprecated Since vX.Y with @see pointing to replacement module"

requirements-completed: [DOCS-03, DOCS-04, DOCS-05]

duration: 5min
completed: 2026-03-03
---

# Phase 15 Plan 03: Documentation Pivot and Gate Deprecation Summary

**Companion skill rewritten for DAG workflows, gate references cleaned from 14 docs, 6 source files deprecated, 3 obsolete doc files deleted**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-03T19:49:43Z
- **Completed:** 2026-03-03T19:54:31Z
- **Tasks:** 2
- **Files modified:** 21

## Accomplishments
- Companion skill (SKILL.md) teaches agents DAG workflow composition with --workflow flag, ad-hoc YAML, common patterns, conditions, and pitfalls
- All 6 gate source files carry @deprecated JSDoc markers pointing to DAG equivalents
- Gate terminology replaced with DAG/hop equivalents across 11 documentation files
- Gate-to-DAG migration section added to migration.md for v1.1 upgraders
- CLI reference regenerated with --workflow flag
- 3 obsolete gate doc files deleted (workflow-gates.md, custom-gates.md, workflow-gates-design.md)
- All 2777 tests pass, all doc checks pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewrite companion skill and add deprecation markers** - `b6463b4` (feat)
2. **Task 2: Gate reference cleanup, CLI regeneration, and file deletion** - `daad16a` (feat)

## Files Created/Modified
- `skills/aof/SKILL.md` - Rewritten workflow section: DAG patterns, --workflow flag, condition DSL, pitfalls, gate-format migration note
- `src/dispatch/gate-evaluator.ts` - @deprecated marker added
- `src/dispatch/gate-transition-handler.ts` - @deprecated marker added
- `src/dispatch/gate-context-builder.ts` - @deprecated marker added
- `src/dispatch/gate-conditional.ts` - @deprecated marker added
- `src/schemas/gate.ts` - @deprecated marker added
- `src/schemas/workflow.ts` - @deprecated marker added
- `docs/guide/task-lifecycle.md` - Gate -> DAG/hop terminology
- `docs/guide/getting-started.md` - Link to workflow-dags.md
- `docs/guide/agent-tools.md` - Gate -> hop terminology
- `docs/guide/configuration.md` - Gate -> DAG terminology
- `docs/guide/org-charts.md` - Gate -> DAG/hop terminology
- `docs/guide/cli-reference.md` - Regenerated with --workflow flag
- `docs/guide/migration.md` - Added gate-to-DAG migration section
- `docs/dev/architecture.md` - Gate -> DAG terminology
- `docs/dev/e2e-test-harness.md` - QA gate -> QA step
- `docs/README.md` - Updated links and titles to DAG equivalents
- `README.md` - Updated workflow gates row to DAG workflows
- `docs/guide/workflow-gates.md` - Deleted
- `docs/guide/custom-gates.md` - Deleted
- `docs/dev/workflow-gates-design.md` - Deleted

## Decisions Made
- Gate source files kept with @deprecated markers (safety net, remove in v1.3 per user decision)
- OpenClaw "gateway" references preserved unchanged -- gateway is the server process, not a workflow gate
- Root README.md also updated (not in original plan file list) to fix broken link from deleted workflow-gates.md

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed broken link in root README.md**
- **Found during:** Task 2 (doc link verification)
- **Issue:** Root README.md referenced deleted docs/guide/workflow-gates.md
- **Fix:** Updated link to docs/guide/workflow-dags.md with updated description
- **Files modified:** README.md
- **Verification:** Doc checker passes
- **Committed in:** daad16a (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential fix to prevent broken link in project README. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 15 (Migration and Documentation) is now complete
- v1.2 milestone is fully delivered: DAG workflow engine, templates, migration, and documentation

---
*Phase: 15-migration-and-documentation*
*Completed: 2026-03-03*
