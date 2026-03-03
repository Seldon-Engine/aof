# Phase 14: Templates, Ad-Hoc API, and Artifacts - Research

**Researched:** 2026-03-03
**Domain:** Workflow template registry, ad-hoc DAG composition, artifact directory conventions
**Confidence:** HIGH

## Summary

Phase 14 adds three capabilities to the existing DAG workflow engine: (1) named workflow templates stored in the project manifest, (2) ad-hoc inline workflow composition by agents via YAML frontmatter, and (3) per-hop artifact directories with documented path conventions for downstream discovery. All three converge on a single runtime schema -- the existing `TaskWorkflow` type containing `WorkflowDefinition` + `WorkflowState`.

The existing codebase provides strong foundations. `WorkflowDefinition`, `validateDAG()`, and `initializeWorkflowState()` are fully implemented and tested from Phases 10-13. The project manifest (`ProjectManifest` in `src/schemas/project.ts`) already has an optional `workflow` field for gate-based workflows. The task store's `create()` method accepts partial frontmatter and writes atomically. The `buildHopContext()` function returns a typed `HopContext` that can be extended with artifact paths. The `dispatchDAGHop()` function is the natural place to create artifact directories before agent spawn.

**Primary recommendation:** Implement as three clean vertical slices -- (1) template schema + resolution + CLI, (2) ad-hoc validation + auto-init in task creation path, (3) artifact directory creation + context injection -- with unification tests proving both paths produce identical runtime schemas.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Templates live in the project manifest (`manifest.yaml`) as a `workflowTemplates` map of named WorkflowDefinition objects
- No parameterization -- templates are static WorkflowDefinition snapshots, used as-is
- Templates referenced by simple name string at task creation: `workflow: { template: 'code-review' }` resolves to the full definition from the project manifest
- `bd task create` gets a `--workflow <template-name>` CLI flag that resolves the template, validates the DAG, and writes the full definition to the task
- Templates validated at project manifest load time via `validateDAG()` -- bad templates caught before any task references them
- Project lint (`bd project lint`) extended to check workflow template validity
- Agents compose ad-hoc DAGs by writing the full `workflow.definition` block directly in task frontmatter YAML -- no new programmatic API
- No template extension/override -- templates and ad-hoc are separate paths (use a template as-is, or compose fully inline)
- Auto-validate + auto-initialize: when a task is created with a `workflow.definition` block, the system runs `validateDAG()` and `initializeWorkflowState()` automatically before writing
- CLI only supports template references via `--workflow` flag; ad-hoc DAGs are frontmatter-only (YAML is the interface)
- Per-hop artifact directories live under the task work directory: `tasks/<id>/work/<hop-id>/`
- Directories auto-created when a hop is dispatched (`mkdir -p` before agent starts)
- Downstream hops discover upstream artifacts via injected paths in `buildHopContext()`: `artifactPaths: { <predecessor-hop-id>: '/path/to/work/<hop-id>/' }` for all completed predecessors
- No size limits or cleanup policy for v1.2 -- artifact cleanup follows task lifecycle; defer dedicated cleanup to a future phase
- Snapshot at creation: template name resolves to full WorkflowDefinition written to task frontmatter at creation time -- tasks are self-contained, template changes don't affect running tasks
- Both paths produce identical runtime schema: `workflow.definition` + `workflow.state` on the task
- Optional `workflow.templateName` field preserved for traceability (informational -- full definition is source of truth)

### Claude's Discretion
- Exact structure of `workflowTemplates` map in project manifest schema
- How template resolution integrates with existing `store.create()` flow
- Internal implementation of artifact directory creation during hop dispatch
- How `buildHopContext()` is extended to include artifact paths alongside existing `upstreamResults`
- Test structure and fixture design for template/artifact scenarios
- Whether `workflow.templateName` lives on `TaskWorkflow` or `WorkflowDefinition`

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TMPL-01 | Workflow templates can be defined in project configuration | Add `workflowTemplates` field to `ProjectManifest` schema as `z.record(z.string(), WorkflowDefinition).optional()`. Validate each template via `validateDAG()` at manifest load time. Extend `lintProject()` for template checks. |
| TMPL-02 | Agent can compose an ad-hoc workflow DAG at task creation time | Add optional `workflow` field to `store.create()` opts. When `workflow.definition` is present, auto-run `validateDAG()` + `initializeWorkflowState()` before writing. YAML frontmatter is the interface (no programmatic API needed). |
| TMPL-03 | Both templates and ad-hoc workflows resolve to the same runtime WorkflowDAG schema | Both paths write identical `TaskWorkflow` (`definition` + `state`) to task frontmatter. Template path: resolve name -> snapshot definition -> init state. Ad-hoc path: parse definition -> validate -> init state. Same `TaskWorkflow` schema. |
| ARTF-01 | Each hop writes output to a per-hop subdirectory in the task work directory | In `dispatchDAGHop()`, call `mkdir -p tasks/<id>/work/<hop-id>/` before spawning agent session. Hop ID is the directory name. |
| ARTF-02 | Downstream hops can read upstream hop outputs via documented directory conventions | Extend `HopContext` interface with `artifactPaths: Record<string, string>`. In `buildHopContext()`, resolve absolute paths for all completed predecessor hop directories. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | (existing) | Schema definition for `workflowTemplates`, `templateName` | Already used for all schemas in codebase |
| write-file-atomic | (existing) | Atomic task file writes after template resolution | Already used in task-store and dag-transition-handler |
| commander | (existing) | `--workflow` CLI flag on `bd task create` | Already used for all CLI commands |
| node:fs/promises | (existing) | `mkdir` for artifact directories | Already used throughout |

### Supporting
No new dependencies. Pure TypeScript/Zod implementation per v1.2 research decision (zero new dependencies).

## Architecture Patterns

### Recommended Changes by File

```
src/schemas/project.ts          # Add workflowTemplates to ProjectManifest
src/schemas/workflow-dag.ts     # Add templateName to TaskWorkflow
src/store/task-store.ts         # Add workflow opts to create(), template resolution
src/dispatch/dag-context-builder.ts  # Add artifactPaths to HopContext + buildHopContext
src/dispatch/dag-transition-handler.ts  # mkdir artifact dir before dispatch
src/cli/commands/task.ts        # --workflow flag on bd task create
src/projects/lint.ts            # Template DAG validation check
```

### Pattern 1: Template Schema in Project Manifest

**What:** Add `workflowTemplates` as an optional record on `ProjectManifest`.
**When to use:** TMPL-01

```typescript
// In src/schemas/project.ts
import { WorkflowDefinition } from "./workflow-dag.js";

export const ProjectManifest = z.object({
  // ... existing fields ...
  workflow: WorkflowConfig.optional(),
  workflowTemplates: z.record(z.string(), WorkflowDefinition).optional(),
});
```

**Rationale:** `z.record(z.string(), WorkflowDefinition)` gives the dictionary-like lookup: `manifest.workflowTemplates?.['code-review']`. The key IS the template name. The value is the exact `WorkflowDefinition` schema already in use. Zod validates each definition structurally on parse. Semantic validation (`validateDAG()`) runs separately at load time / lint time.

### Pattern 2: Template Resolution at Task Creation

**What:** Resolve template name to full `WorkflowDefinition`, snapshot it on the task.
**When to use:** TMPL-01, TMPL-03

```typescript
// Conceptual flow in store.create() or a helper:
function resolveTemplate(
  manifest: ProjectManifest,
  templateName: string,
): TaskWorkflow {
  const templates = manifest.workflowTemplates;
  if (!templates?.[templateName]) {
    throw new Error(`Workflow template "${templateName}" not found in project manifest`);
  }
  const definition = templates[templateName];
  const errors = validateDAG(definition);
  if (errors.length > 0) {
    throw new Error(`Template "${templateName}" invalid: ${errors.join(", ")}`);
  }
  const state = initializeWorkflowState(definition);
  return { definition, state, templateName };
}
```

**Key:** The resolved `TaskWorkflow` includes `templateName` for traceability but the full `definition` is the source of truth. This means `templateName` should live on `TaskWorkflow` (not `WorkflowDefinition`) since it's metadata about how the workflow was sourced, not part of the definition itself.

### Pattern 3: Ad-Hoc Workflow Auto-Validation

**What:** When task is created with inline `workflow.definition`, auto-validate and auto-initialize state.
**When to use:** TMPL-02, TMPL-03

```typescript
// In store.create() flow, after frontmatter assembly:
if (opts.workflow?.definition) {
  const errors = validateDAG(opts.workflow.definition);
  if (errors.length > 0) {
    throw new Error(`Ad-hoc workflow invalid: ${errors.join(", ")}`);
  }
  frontmatter.workflow = {
    definition: opts.workflow.definition,
    state: initializeWorkflowState(opts.workflow.definition),
  };
}
```

**Key:** Same validation + init path as templates, just without the name lookup. Both produce identical `TaskWorkflow` runtime objects.

### Pattern 4: Artifact Directory Creation + Context Injection

**What:** Create hop artifact dir before dispatch; inject paths into HopContext.
**When to use:** ARTF-01, ARTF-02

```typescript
// In dispatchDAGHop() before spawnSession:
const taskDir = dirname(task.path!);
const hopWorkDir = join(taskDir, "work", hopId);
await mkdir(hopWorkDir, { recursive: true });

// In buildHopContext(), extend return:
const artifactPaths: Record<string, string> = {};
for (const predId of hop.dependsOn) {
  const predState = state.hops[predId];
  if (predState?.status === "complete") {
    artifactPaths[predId] = join(dirname(task.path!), "work", predId);
  }
}
return {
  hopId, description: hop.description, role: hop.role,
  upstreamResults, autoAdvance: hop.autoAdvance,
  artifactPaths,
};
```

**Note:** `buildHopContext()` currently takes only `task` and `hopId`. It needs access to the task's file path to resolve artifact directories. The task object already has `task.path` set when loaded from store.

### Pattern 5: TaskWorkflow Schema Extension

**What:** Add optional `templateName` field to `TaskWorkflow`.
**Where:** `src/schemas/workflow-dag.ts`

```typescript
export const TaskWorkflow = z.object({
  definition: WorkflowDefinition,
  state: WorkflowState,
  templateName: z.string().optional(),  // Traceability only
});
```

**Rationale:** `templateName` on `TaskWorkflow` (not `WorkflowDefinition`) because it describes the task's relationship to a template, not the workflow structure itself. Templates don't need to know they're templates; they're just `WorkflowDefinition` objects.

### Anti-Patterns to Avoid
- **Lazy template resolution at dispatch time:** Resolve at creation time (snapshot). Tasks must be self-contained.
- **Modifying WorkflowDefinition schema for template metadata:** Keep templates as plain `WorkflowDefinition` objects. Template metadata belongs on `TaskWorkflow`.
- **Building a separate template registry service:** Templates are just a field on the project manifest -- no separate registry needed.
- **Adding workflow field to `store.create()` opts and passing through Zod parse:** The workflow field needs validation + init BEFORE the Zod parse. Handle it explicitly in the create flow.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| DAG validation | Custom template validator | `validateDAG()` from workflow-dag.ts | Already handles cycles, reachability, conditions, timeouts |
| State initialization | Custom template state init | `initializeWorkflowState()` from workflow-dag.ts | Already derives root hops as ready |
| Atomic file writes | Manual write-then-rename | `writeFileAtomic` (already imported) | Race condition handling |
| CLI flag parsing | Manual argv parsing | Commander `.option()` pattern | Consistent with existing flags |

## Common Pitfalls

### Pitfall 1: Task Path Availability in buildHopContext
**What goes wrong:** `buildHopContext()` currently only uses task frontmatter data. Artifact paths require the task's filesystem path (`task.path`).
**Why it happens:** The function signature takes `Task` which has an optional `path` field. In normal flows it's set, but in unit tests it may not be.
**How to avoid:** Assert `task.path` is defined at the top of buildHopContext when artifact paths are requested. In tests, always set `task.path` on fixture objects.
**Warning signs:** `undefined` appearing in artifact path strings.

### Pitfall 2: Template Validation Timing
**What goes wrong:** Templates validated only at task creation time, not at manifest load. Bad templates sit undetected until someone references them.
**Why it happens:** Forgetting that manifest load is separate from task creation.
**How to avoid:** Validate all templates at manifest load time (project lint) AND at task creation time (belt-and-suspenders). Per user decision, this is required.
**Warning signs:** Invalid templates not caught by `bd project lint`.

### Pitfall 3: Zod Record Key Type
**What goes wrong:** `z.record(z.string(), WorkflowDefinition)` allows any string key. Template names could contain spaces, special chars, etc.
**How to avoid:** Consider adding a regex constraint on the key or validating template names separately. At minimum, document that template names should follow identifier conventions (alphanumeric + hyphens).
**Warning signs:** Template names with spaces or special chars causing issues in CLI flag values.

### Pitfall 4: Work Directory Structure
**What goes wrong:** The task store's `ensureTaskDirs()` creates `work/`, `outputs/`, and `subtasks/` directories. Artifact directories are `work/<hop-id>/` subdirectories. Collision if a hop ID matches an existing subdirectory.
**Why it happens:** Hop IDs like "work" or "outputs" could technically clash.
**How to avoid:** Hop IDs are user-defined and validated as non-empty strings. The directory structure `work/<hop-id>/` nests under `work/` so no collision with peer dirs. But do ensure `ensureTaskDirs` has already created the `work/` parent before `dispatchDAGHop` creates `work/<hop-id>/`.
**Warning signs:** `ENOENT` errors on mkdir if parent `work/` doesn't exist (should never happen since `ensureTaskDirs` runs at create time, but `{ recursive: true }` handles it anyway).

### Pitfall 5: Store Create Flow and Workflow Field
**What goes wrong:** The current `store.create()` does not accept a `workflow` option. Adding it requires modifying the opts type AND ensuring the workflow is properly constructed before `TaskFrontmatter.parse()`.
**Why it happens:** `TaskFrontmatter.parse()` expects the full workflow object (definition + state), not just a definition.
**How to avoid:** Build the complete `TaskWorkflow` object (definition + state + optional templateName) BEFORE passing to `TaskFrontmatter.parse()`. The create method should accept either `{ template: string }` (for template resolution) or `{ definition: WorkflowDefinition }` (for ad-hoc), resolve it to a full `TaskWorkflow`, then include it in the frontmatter parse.
**Warning signs:** Zod parse errors from incomplete workflow objects.

## Code Examples

### Template in manifest.yaml
```yaml
# project.yaml
id: my-project
title: My Project
# ... other fields ...
workflowTemplates:
  code-review:
    name: code-review
    hops:
      - id: implement
        role: swe-backend
        autoAdvance: true
      - id: review
        role: swe-qa
        dependsOn: [implement]
        canReject: true
        rejectionStrategy: origin
  deploy-pipeline:
    name: deploy-pipeline
    hops:
      - id: build
        role: swe-backend
      - id: test
        role: swe-qa
        dependsOn: [build]
      - id: deploy
        role: ops
        dependsOn: [test]
```

### CLI Usage
```bash
# Create task with template workflow
bd task create "Fix login bug" --workflow code-review --project my-project

# Ad-hoc workflow: agent writes full definition in task YAML frontmatter
# (no CLI flag -- frontmatter-only interface)
```

### Task Frontmatter After Template Resolution
```yaml
---
id: "250303-001"
title: "Fix login bug"
status: backlog
workflow:
  templateName: code-review     # traceability only
  definition:
    name: code-review
    hops:
      - id: implement
        role: swe-backend
        autoAdvance: true
      - id: review
        role: swe-qa
        dependsOn: [implement]
        canReject: true
        rejectionStrategy: origin
  state:
    status: pending
    hops:
      implement:
        status: ready
      review:
        status: pending
---
```

### HopContext with Artifact Paths
```typescript
// What the agent receives when dispatched for the "review" hop:
{
  hopId: "review",
  description: "Code review",
  role: "swe-qa",
  autoAdvance: false,
  upstreamResults: {
    implement: { notes: "Implemented login fix in auth.ts" }
  },
  artifactPaths: {
    implement: "/vault/Projects/my-project/Tasks/250303-001/work/implement/"
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Gate-based linear workflows | DAG-based workflows | Phase 10-12 | Templates use DAG schema, not gate schema |
| No workflow templates | Manifest-level templates | Phase 14 (this phase) | Reusable workflows without copy-paste |
| No artifact directories | Per-hop work dirs | Phase 14 (this phase) | Structured handoff between hops |

## Open Questions

1. **Template name validation**
   - What we know: Template names are record keys in YAML. Any string is valid in Zod's `z.record()`.
   - What's unclear: Should we enforce naming conventions (e.g., lowercase alphanumeric + hyphens)?
   - Recommendation: Add a regex-validated key or validate names in `lintProject()`. Follow the project ID pattern: `[a-z0-9][a-z0-9-]+`.

2. **ProjectManifest loading for template resolution**
   - What we know: `store.create()` currently does not load the project manifest. The CLI command has access to project context.
   - What's unclear: How to pass the manifest (or just the templates map) to the store's create flow.
   - Recommendation: Template resolution happens in the CLI command handler (which already loads project context), NOT inside `store.create()`. The CLI resolves template -> WorkflowDefinition, then passes the full workflow to `store.create()`. This keeps the store simple and avoids circular dependencies.

3. **Artifact path resolution with task.path**
   - What we know: `buildHopContext()` takes `Task` which has optional `path`. Loaded tasks always have `path` set.
   - What's unclear: Whether any code path calls `buildHopContext` without `task.path`.
   - Recommendation: Add a guard (`if (!task.path) throw`) and ensure all test fixtures set `task.path`.

## Sources

### Primary (HIGH confidence)
- `src/schemas/workflow-dag.ts` -- WorkflowDefinition, validateDAG, initializeWorkflowState (read directly)
- `src/schemas/project.ts` -- ProjectManifest schema with existing workflow field (read directly)
- `src/dispatch/dag-context-builder.ts` -- HopContext interface and buildHopContext (read directly)
- `src/dispatch/dag-transition-handler.ts` -- dispatchDAGHop with spawn flow (read directly)
- `src/store/task-store.ts` -- store.create() method and ensureTaskDirs (read directly)
- `src/schemas/workflow.ts` -- WorkflowConfig (gate-based, for reference) (read directly)
- `src/cli/commands/task.ts` -- CLI task create command (read directly)
- `src/projects/lint.ts` -- Project lint structure (read directly)

### Secondary (MEDIUM confidence)
- None needed -- all findings from direct code inspection

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies, all existing code inspected
- Architecture: HIGH -- all integration points identified with exact file/line locations
- Pitfalls: HIGH -- derived from actual code inspection of create flow, context builder, and directory structure

**Research date:** 2026-03-03
**Valid until:** 2026-04-03 (stable internal codebase, no external dependencies)
