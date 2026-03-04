---
phase: 21-tool-workflow-api
plan: 02
subsystem: api
tags: [mcp, workflow, dag, zod, template-resolution]

# Dependency graph
requires:
  - phase: 14-templates
    provides: WorkflowDefinition schema, validateDAG(), workflowTemplates in ProjectManifest
  - phase: 18-dag-as-default
    provides: store.create() workflow parameter, initializeWorkflowState()
provides:
  - workflow parameter on aof_dispatch MCP tool (string template name, inline DAG, or false)
  - projectConfig field on AofMcpContext for template resolution
  - dispatch-workflow test suite (7 tests)
affects: [22-tool-trimming, 23-tiered-delivery]

# Tech tracking
tech-stack:
  added: []
  patterns: [workflow-resolution-in-mcp-handler, zod-union-for-polymorphic-input]

key-files:
  created:
    - src/mcp/__tests__/dispatch-workflow.test.ts
  modified:
    - src/mcp/tools.ts
    - src/mcp/shared.ts

key-decisions:
  - "No auto-default workflow when workflow param omitted -- agents are explicit, surprise workflow attachment would be confusing"
  - "Workflow parameter uses z.union([string, WorkflowDefinition, z.literal(false)]) for clean polymorphic input"
  - "Template resolution happens in handleAofDispatch, not in store -- matches CLI pattern where resolution is caller responsibility"

patterns-established:
  - "AofMcpContext.projectConfig provides project manifest access for MCP tool handlers"
  - "Workflow resolution pattern: string -> template lookup -> validateDAG -> store.create({ workflow })"

requirements-completed: [TOOL-03, TOOL-04]

# Metrics
duration: 5min
completed: 2026-03-04
---

# Phase 21 Plan 02: Workflow Dispatch API Summary

**aof_dispatch MCP tool now accepts workflow parameter for template name resolution, inline DAG validation, and explicit skip via false**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-04T12:38:13Z
- **Completed:** 2026-03-04T12:44:00Z
- **Tasks:** 1 (TDD: 3 commits)
- **Files modified:** 3

## Accomplishments
- aof_dispatch accepts workflow as string (template name), WorkflowDefinition object (inline DAG), or false (explicit skip)
- Template names resolved from AofMcpContext.projectConfig.workflowTemplates with clear error on unknown template
- Inline DAGs validated via validateDAG() with MCP error listing all validation failures
- Backward compatible: omitting workflow param creates task without workflow
- 7 new tests covering all workflow parameter behaviors

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Failing workflow tests** - `39bce4f` (test)
2. **Task 1 (GREEN): Workflow parameter implementation** - `83d72a8` (feat)
3. **Task 1 (REFACTOR): Clean up imports and type guards** - `40a260d` (refactor)

## Files Created/Modified
- `src/mcp/__tests__/dispatch-workflow.test.ts` - 7 tests covering template resolution, inline DAG, validation errors, backward compat, explicit skip
- `src/mcp/tools.ts` - Added workflow field to dispatchInputSchema, workflow resolution logic in handleAofDispatch
- `src/mcp/shared.ts` - Added projectConfig to AofMcpContext, load project manifest in createAofMcpContext

## Decisions Made
- No auto-default workflow when workflow param is omitted. Agents are explicit -- surprise workflow attachment would be confusing. This differs from CLI (which has auto-default) but is appropriate for MCP tool usage.
- Template resolution happens in the MCP handler (handleAofDispatch), not in the store. Matches the established CLI pattern where the caller resolves templates and the store only receives complete workflow objects.
- Used z.union for the workflow parameter rather than separate fields, keeping the API surface clean.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Workflow dispatch API is complete and tested
- Ready for Phase 22 (tool trimming) and Phase 23 (tiered delivery)
- projectConfig on AofMcpContext can be leveraged by future MCP tool enhancements

## Self-Check: PASSED

- All 3 key files verified on disk
- All 3 commits (39bce4f, 83d72a8, 40a260d) verified in git log
- All 2811 existing tests pass, 7 new tests pass

---
*Phase: 21-tool-workflow-api*
*Completed: 2026-03-04*
