# Phase 14: Templates, Ad-Hoc API, and Artifacts - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Users define reusable workflow templates in project configuration, agents compose ad-hoc workflow DAGs inline at task creation, and hops exchange artifacts through per-hop subdirectories in the task work area. Both template-referenced and ad-hoc workflows resolve to the same runtime WorkflowDAG schema at creation time. No migration (Phase 15), no new safety/timeout logic (Phase 13 complete).

</domain>

<decisions>
## Implementation Decisions

### Template storage & resolution
- Templates live in the project manifest (`manifest.yaml`) as a `workflowTemplates` map of named WorkflowDefinition objects
- No parameterization — templates are static WorkflowDefinition snapshots, used as-is
- Templates referenced by simple name string at task creation: `workflow: { template: 'code-review' }` resolves to the full definition from the project manifest
- `bd task create` gets a `--workflow <template-name>` CLI flag that resolves the template, validates the DAG, and writes the full definition to the task
- Templates validated at project manifest load time via `validateDAG()` — bad templates caught before any task references them
- Project lint (`bd project lint`) extended to check workflow template validity

### Ad-hoc workflow composition
- Agents compose ad-hoc DAGs by writing the full `workflow.definition` block directly in task frontmatter YAML — no new programmatic API
- No template extension/override — templates and ad-hoc are separate paths (use a template as-is, or compose fully inline)
- Auto-validate + auto-initialize: when a task is created with a `workflow.definition` block, the system runs `validateDAG()` and `initializeWorkflowState()` automatically before writing
- CLI only supports template references via `--workflow` flag; ad-hoc DAGs are frontmatter-only (YAML is the interface)

### Artifact directory conventions
- Per-hop artifact directories live under the task work directory: `tasks/<id>/work/<hop-id>/`
- Directories auto-created when a hop is dispatched (`mkdir -p` before agent starts)
- Downstream hops discover upstream artifacts via injected paths in `buildHopContext()`: `artifactPaths: { <predecessor-hop-id>: '/path/to/work/<hop-id>/' }` for all completed predecessors
- No size limits or cleanup policy for v1.2 — artifact cleanup follows task lifecycle; defer dedicated cleanup to a future phase

### Template/ad-hoc unification
- Snapshot at creation: template name resolves to full WorkflowDefinition written to task frontmatter at creation time — tasks are self-contained, template changes don't affect running tasks
- Both paths produce identical runtime schema: `workflow.definition` + `workflow.state` on the task
- Optional `workflow.templateName` field preserved for traceability (informational — full definition is source of truth)

### Claude's Discretion
- Exact structure of `workflowTemplates` map in project manifest schema
- How template resolution integrates with existing `store.create()` flow
- Internal implementation of artifact directory creation during hop dispatch
- How `buildHopContext()` is extended to include artifact paths alongside existing `upstreamResults`
- Test structure and fixture design for template/artifact scenarios
- Whether `workflow.templateName` lives on `TaskWorkflow` or `WorkflowDefinition`

</decisions>

<specifics>
## Specific Ideas

- The template lookup should feel like a dictionary: `projectManifest.workflowTemplates['code-review']` → WorkflowDefinition
- Snapshotting means the task file is always the single source of truth for what workflow is running — no external dependency at dispatch time
- Artifact directories use hop ID as the folder name: `work/implement/`, `work/review/` — human-readable and greppable
- The `--workflow` CLI flag mirrors the existing `--priority` and `--project` flags — same ergonomic pattern

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/schemas/workflow-dag.ts`: `WorkflowDefinition` schema (name + hops array) — templates are named instances of this exact schema
- `src/schemas/workflow-dag.ts`: `validateDAG()` — already validates hop topology, conditions, references; reuse for template validation
- `src/schemas/workflow-dag.ts`: `initializeWorkflowState()` — auto-initialization at creation time
- `src/dispatch/dag-context-builder.ts`: `buildHopContext()` — extend with `artifactPaths` field for downstream discovery
- `src/schemas/project.ts`: `ProjectManifest` with `workflow: WorkflowConfig.optional()` — add `workflowTemplates` alongside or within this
- `src/cli/commands/task.ts`: `bd task create` with `store.create()` — add `--workflow` flag and template resolution
- `src/projects/lint.ts`: Project lint checks — add template validation check

### Established Patterns
- Zod schemas define shapes, TypeScript types derived via `z.infer<>`
- Project manifest validated at load time via Zod parse
- `store.create()` accepts a partial frontmatter object and writes atomically
- `buildHopContext()` returns a typed context object injected into agent dispatch
- CLI flags use Commander.js `.option()` pattern

### Integration Points
- `src/schemas/project.ts`: Add `workflowTemplates` field to `ProjectManifest` (or extend `WorkflowConfig`)
- `src/schemas/workflow-dag.ts`: Add optional `templateName` field to `TaskWorkflow`
- `src/store/task-store.ts` or `task-mutations.ts`: Template resolution + auto-validate + auto-init in task creation path
- `src/dispatch/dag-context-builder.ts`: Extend `buildHopContext()` with artifact paths
- `src/dispatch/dag-transition-handler.ts`: Create hop artifact directory on dispatch
- `src/cli/commands/task.ts`: Add `--workflow` flag to `bd task create`
- `src/projects/lint.ts`: Add workflow template DAG validation check

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 14-templates-ad-hoc-api-and-artifacts*
*Context gathered: 2026-03-03*
