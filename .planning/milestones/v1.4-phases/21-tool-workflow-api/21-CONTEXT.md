# Phase 21: Tool & Workflow API - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a `workflow` parameter to `aof_dispatch` so agents can compose DAG workflows through MCP tools. Also trim tool descriptions to one-liners and merge the projects skill into the main SKILL.md. This closes the v1.2 TMPL-02 gap where workflow composition was only available via CLI/YAML frontmatter.

</domain>

<decisions>
## Implementation Decisions

### Workflow parameter design
- Support BOTH template name (string) AND inline DAG definition (full WorkflowDefinition object)
- Template name: `workflow: "standard-review"` → resolved from project.yaml `workflowTemplates`
- Inline definition: `workflow: { name: "...", hops: [...] }` → passed directly as ad-hoc DAG
- Match the CLI's resolution pattern: template name is a convenience, inline is the power path
- Validation: inline DAGs validated via existing `validateDAG()`, template names validated against project manifest

### Default workflow behavior (Claude's discretion)
- Claude decides whether aof_dispatch should auto-apply the project's `defaultWorkflow` when no workflow param is given
- Reference: CLI has 3-tier precedence (--no-workflow → explicit template → auto-default)
- Consider: agents are explicit — they may not want surprise workflow attachment

### Tool description trimming
- Tool descriptions in `registerTool()` calls are already one-liners — minimal trimming needed there
- The real work is ensuring the NEW workflow parameter has a clean, non-redundant description
- Don't bloat descriptions to explain workflow composition — that's the skill's job (Phase 22)

### Projects skill merge
- Fold the 50-line `src/skills/projects/SKILL.md` into the main `skills/aof/SKILL.md` now
- Content: 3 project tools (aof_project_create, aof_project_list, aof_project_add_participant) + isolation rules
- Compress during merge — the isolation rules can be 2-3 bullet points, not a full section
- Delete `src/skills/projects/SKILL.md` after merge (single file injection going forward)

### Claude's Discretion
- Schema design for the workflow parameter (union type vs two separate fields vs discriminated union)
- Whether to support `workflow: false` to explicitly skip default workflow (like CLI's `--no-workflow`)
- Error messages for invalid template names or DAG validation failures
- How to access project manifest from MCP context (may need to thread project config through AofMcpContext)

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. The key constraint is matching the store's existing `workflow: { definition, templateName }` interface while supporting both template name shorthand and inline DAG definitions.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/store/task-store.ts`: `create()` already accepts `workflow: { definition: WorkflowDefinition; templateName?: string }` — fully wired
- `src/schemas/workflow-dag.ts`: `WorkflowDefinition` schema (name + hops array), `validateDAG()`, `initializeWorkflowState()`
- `src/cli/commands/task-create-workflow.ts`: `resolveWorkflowTemplate()` and `resolveDefaultWorkflow()` — template resolution logic to reuse
- `src/schemas/project.ts`: `ProjectManifest` with `workflowTemplates` record and `defaultWorkflow` field
- `src/cli/commands/__tests__/task-create-workflow.test.ts`: Comprehensive test patterns for template resolution + DAG validation

### Established Patterns
- CLI task creation: resolve template → validate DAG → pass to store.create()
- DAG validation via `validateDAG()` returns error array (empty = valid)
- State initialization via `initializeWorkflowState()` sets root hops to "ready"
- Template names validated against project manifest's `workflowTemplates` record

### Integration Points
- `src/mcp/tools.ts`: Add workflow to `dispatchInputSchema`, wire through `handleAofDispatch`
- `src/mcp/shared.ts`: `AofMcpContext` may need project config access for template resolution
- `skills/aof/SKILL.md`: Merge projects skill content into this file
- `src/skills/projects/SKILL.md`: Delete after merge

### Wiring Path (what needs to change)
```
dispatchInputSchema  → add workflow field (string | WorkflowDefinition)
handleAofDispatch()  → resolve template name OR pass inline definition
                     → validate DAG
                     → pass { definition, templateName? } to store.create()
```

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 21-tool-workflow-api*
*Context gathered: 2026-03-03*
