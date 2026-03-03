---
phase: 14-templates-ad-hoc-api-and-artifacts
plan: 01
subsystem: schemas
tags: [zod, workflow-templates, project-manifest, lint, dag-validation]

requires:
  - phase: 10-workflow-dag-schema
    provides: WorkflowDefinition, validateDAG, TaskWorkflow Zod schemas
provides:
  - workflowTemplates optional record field on ProjectManifest with regex-validated keys
  - templateName optional traceability field on TaskWorkflow
  - Lint check for workflow template DAG structural validity
affects: [14-02-ad-hoc-api, 14-03-template-registry, 15-migration]

tech-stack:
  added: []
  patterns:
    - z.record(TemplateNameKey, WorkflowDefinition) for typed map with validated keys
    - Lint pipeline extension pattern (add function, call in lintProject)

key-files:
  created: []
  modified:
    - src/schemas/project.ts
    - src/schemas/workflow-dag.ts
    - src/projects/lint.ts
    - src/schemas/__tests__/project.test.ts
    - src/schemas/__tests__/workflow-dag.test.ts
    - src/projects/__tests__/lint.test.ts

key-decisions:
  - "TemplateNameKey uses ^[a-z0-9][a-z0-9-]*$ regex (matches project ID convention without length limit)"
  - "workflowTemplates is optional on ProjectManifest (backward compatible, no migration needed)"
  - "templateName on TaskWorkflow is informational-only (full definition is source of truth)"
  - "Lint category 'workflow-templates' separates template DAG errors from other lint categories"

patterns-established:
  - "Template name key validation via exported TemplateNameKey Zod schema (reusable by registry)"
  - "validateWorkflowTemplates as sync lint check (no I/O needed, DAG validation is pure)"

requirements-completed: [TMPL-01, TMPL-03]

duration: 3min
completed: 2026-03-03
---

# Phase 14 Plan 01: Workflow Template Schema Summary

**ProjectManifest workflowTemplates field with regex-validated keys, TaskWorkflow templateName traceability, and lint DAG validation**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-03T18:33:33Z
- **Completed:** 2026-03-03T18:36:49Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- ProjectManifest accepts optional `workflowTemplates` record of named WorkflowDefinition objects
- Template name keys validated via `TemplateNameKey` schema (lowercase alphanumeric + hyphens)
- TaskWorkflow has optional `templateName` field for traceability
- Project lint validates template DAGs via `validateDAG()` and reports errors with template names
- All 375 existing tests pass (full backward compatibility)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add workflowTemplates to ProjectManifest and templateName to TaskWorkflow** - `ae3b810` (feat)
2. **Task 2: Extend project lint to validate workflow template DAGs** - `fd5716a` (feat)

_Note: TDD tasks combined RED+GREEN into single commits for atomicity._

## Files Created/Modified
- `src/schemas/project.ts` - Added TemplateNameKey schema and workflowTemplates field on ProjectManifest
- `src/schemas/workflow-dag.ts` - Added optional templateName field on TaskWorkflow
- `src/projects/lint.ts` - Added validateWorkflowTemplates check to lintProject pipeline
- `src/schemas/__tests__/project.test.ts` - Tests for workflowTemplates parsing, validation, backward compat, and TemplateNameKey regex
- `src/schemas/__tests__/workflow-dag.test.ts` - Tests for TaskWorkflow templateName presence and absence
- `src/projects/__tests__/lint.test.ts` - Tests for template DAG lint: absent, valid, invalid, error format

## Decisions Made
- TemplateNameKey uses `^[a-z0-9][a-z0-9-]*$` regex -- mirrors project ID convention without length limit, allows single-character names
- workflowTemplates is optional on ProjectManifest -- backward compatible, no migration needed
- templateName on TaskWorkflow is informational-only -- full definition embedded in TaskWorkflow is source of truth, templateName just aids debugging/tracing
- Lint uses category `workflow-templates` for template-specific errors -- separates from existing manifest/structure/hierarchy categories

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- workflowTemplates schema ready for Plan 02 (ad-hoc API) and Plan 03 (template registry)
- TemplateNameKey exported for reuse by template instantiation logic
- validateDAG integration in lint provides safety net for template authoring

---
*Phase: 14-templates-ad-hoc-api-and-artifacts*
*Completed: 2026-03-03*
