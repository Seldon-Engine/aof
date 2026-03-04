# Phase 18: DAG-as-Default - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

When `bd create` makes a new task, auto-attach the project's configured `defaultWorkflow` template. Projects without a default continue as bare-task. A `--no-workflow` flag opts out explicitly. Covers requirements DAGD-01, DAGD-02, DAGD-03.

</domain>

<decisions>
## Implementation Decisions

### CLI flag precedence
- `--workflow <name>` (explicit template) takes highest priority — overrides defaultWorkflow
- `--no-workflow` suppresses defaultWorkflow attachment, creates bare task
- No flags + defaultWorkflow configured → auto-attach defaultWorkflow
- No flags + no defaultWorkflow → bare task (existing behavior, graceful degradation)

### Claude's Discretion
- Whether `--workflow` and `--no-workflow` conflict should be an error or `--no-workflow` wins
- Output feedback on workflow attachment (silent vs confirmation line)
- Error handling when `defaultWorkflow` references a nonexistent template (fail loudly vs warn and create bare)
- Test approach and scope

</decisions>

<specifics>
## Specific Ideas

No specific requirements — the three success criteria from ROADMAP.md are precise enough:
1. `bd create "task name"` with defaultWorkflow → auto-attaches workflow
2. `bd create --no-workflow "task name"` → bare task even with defaultWorkflow
3. `bd create "task name"` without defaultWorkflow → bare task, no errors

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `resolveWorkflowTemplate(templateName, projectRoot)` in `src/cli/commands/task-create-workflow.ts`: Already resolves template name → WorkflowDefinition with DAG validation. Reuse for defaultWorkflow resolution.
- `ProjectManifest.defaultWorkflow` field (z.string().optional()) in `src/schemas/project.ts:139`: Added in Phase 17 migration 001.
- `workflowTemplates` map in ProjectManifest: Named DAG definitions already validated by schema.

### Established Patterns
- `bd create` action in `src/cli/commands/task.ts:27`: Currently only resolves workflow when `--workflow` flag is present. Needs conditional: if no `--workflow` flag, check manifest for `defaultWorkflow`.
- Project manifest loaded in `resolveWorkflowTemplate()` via `parseYaml` + `ProjectManifest.parse()` — same pattern can load `defaultWorkflow` field.

### Integration Points
- `src/cli/commands/task.ts:27-38`: The create action handler — add `--no-workflow` option and defaultWorkflow resolution logic here.
- `src/cli/commands/task-create-workflow.ts`: May need a new function (e.g., `resolveDefaultWorkflow(projectRoot)`) or extend existing `resolveWorkflowTemplate`.
- `store.create()` call at task.ts:40 — the `workflow` parameter is already optional; passing undefined = bare task.

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 18-dag-as-default*
*Context gathered: 2026-03-03*
