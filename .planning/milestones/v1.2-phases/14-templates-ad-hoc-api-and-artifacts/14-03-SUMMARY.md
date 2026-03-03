---
phase: 14-templates-ad-hoc-api-and-artifacts
plan: 03
subsystem: store, cli
tags: [workflow-templates, dag-validation, task-store, cli-flags, template-resolution]

requires:
  - phase: 14-01-workflow-template-schema
    provides: workflowTemplates on ProjectManifest, TemplateNameKey, templateName on TaskWorkflow
  - phase: 10-workflow-dag-schema
    provides: validateDAG, initializeWorkflowState, WorkflowDefinition, TaskWorkflow
provides:
  - store.create() auto-validates and auto-initializes workflow DAGs (ad-hoc and template-resolved)
  - CLI --workflow flag resolves template name from project manifest workflowTemplates
  - resolveWorkflowTemplate helper for CLI template resolution
  - Both ad-hoc and template paths produce identical TaskWorkflow runtime objects
affects: [15-migration, scheduler-dag-dispatch]

tech-stack:
  added: []
  patterns:
    - "Workflow validation before TaskFrontmatter.parse() (pre-validation pattern)"
    - "CLI template resolution in separate module (task-create-workflow.ts) for testability"
    - "Belt-and-suspenders DAG validation on template resolution (defense-in-depth)"

key-files:
  created:
    - src/cli/commands/task-create-workflow.ts
    - src/store/__tests__/task-store-workflow.test.ts
    - src/cli/commands/__tests__/task-create-workflow.test.ts
  modified:
    - src/store/task-store.ts
    - src/store/interfaces.ts
    - src/cli/commands/task.ts

key-decisions:
  - "Template resolution happens in CLI command handler, not in store.create() (keeps store simple)"
  - "resolveWorkflowTemplate extracted as separate testable module (not inline in commander action)"
  - "Belt-and-suspenders validateDAG in both resolveWorkflowTemplate and store.create() (defense-in-depth)"

patterns-established:
  - "Pre-validation pattern: validate workflow before TaskFrontmatter.parse() to produce clear errors"
  - "CLI helper module pattern: extract complex flag logic into task-create-*.ts for unit testing"

requirements-completed: [TMPL-02, TMPL-03]

duration: 4min
completed: 2026-03-03
---

# Phase 14 Plan 03: CLI Workflow Flag and Store Ad-hoc API Summary

**CLI --workflow flag with template resolution from project manifest, store.create() auto-validate and auto-init for ad-hoc workflow DAGs**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-03T18:41:03Z
- **Completed:** 2026-03-03T18:45:22Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- store.create() accepts optional workflow parameter, auto-validates DAG via validateDAG, auto-initializes state via initializeWorkflowState
- Invalid DAGs throw descriptive errors before task creation
- CLI --workflow flag resolves template name from project manifest workflowTemplates record
- Both ad-hoc (agent-authored) and template-resolved workflows produce identical TaskWorkflow runtime objects
- templateName preserved for traceability on template-sourced workflows
- All 245 store + CLI tests pass (11 new tests added)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add workflow support to store.create() with auto-validate and auto-init** - `026e0f6` (test) + `88c487d` (feat)
2. **Task 2: Add --workflow CLI flag with template resolution** - `d00dad4` (test) + `1f48bcd` (feat)

_Note: TDD tasks have separate test (RED) and feat (GREEN) commits._

## Files Created/Modified
- `src/store/task-store.ts` - Added workflow validation and state initialization in create() method
- `src/store/interfaces.ts` - Added workflow parameter to ITaskStore.create() opts
- `src/cli/commands/task.ts` - Added --workflow flag to task create command with template resolution
- `src/cli/commands/task-create-workflow.ts` - New module: resolveWorkflowTemplate helper for CLI
- `src/store/__tests__/task-store-workflow.test.ts` - 6 tests: auto-validate, invalid DAG, backward compat, templateName, round-trip
- `src/cli/commands/__tests__/task-create-workflow.test.ts` - 5 tests: resolution, unknown template error, missing templates, traceability, end-to-end

## Decisions Made
- Template resolution happens in CLI command handler (task-create-workflow.ts), not in store.create() -- keeps store simple, CLI is responsible for manifest lookup
- resolveWorkflowTemplate extracted as separate module rather than inline in commander action -- enables direct unit testing without commander overhead
- Belt-and-suspenders validateDAG called in both resolveWorkflowTemplate (CLI) and store.create() (store) -- defense-in-depth ensures invalid DAGs never persist regardless of entry path

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- store.create() workflow support ready for agent ad-hoc DAG composition (YAML frontmatter path)
- CLI --workflow flag ready for human/agent use with project manifests containing workflowTemplates
- Phase 14 complete: all 3 plans delivered (schema, artifacts, API)
- Phase 15 (migration) can proceed with workflow-aware task creation

## Self-Check: PASSED

- All 6 created/modified files verified on disk
- All 4 task commits (026e0f6, 88c487d, d00dad4, 1f48bcd) verified in git log
- 245 store + CLI tests passing (28 test files)
- TypeScript type check clean (no errors)

---
*Phase: 14-templates-ad-hoc-api-and-artifacts*
*Completed: 2026-03-03*
