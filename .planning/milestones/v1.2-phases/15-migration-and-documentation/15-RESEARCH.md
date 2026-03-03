# Phase 15: Migration and Documentation - Research

**Researched:** 2026-03-03
**Domain:** Lazy gate-to-DAG migration, documentation rewrite, companion skill update
**Confidence:** HIGH

## Summary

Phase 15 covers two distinct domains: (1) runtime migration of existing gate-format task workflows to DAG format, and (2) comprehensive documentation rewrite to replace all gate references with DAG equivalents. The migration is a code task centered on the task store load path, while the documentation work spans ~30 files across user guides, developer docs, examples, companion skill, and auto-generated CLI reference.

The migration implementation is straightforward: detect gate-format frontmatter on task load in `task-store.ts`, convert the linear gate sequence to an equivalent DAG definition with `initializeWorkflowState()`, map in-flight gate position to hop state, write back atomically. The gate evaluation code in `src/dispatch/` stays intact with deprecation markers. No new dependencies are needed.

The documentation scope is large but mechanical. Three categories: (a) full replacements (workflow-gates.md, custom-gates.md, workflow-gates-design.md, 3 example YAMLs), (b) updates to ~14 other doc files that reference gates, and (c) companion skill rewrite plus CLI reference regeneration.

**Primary recommendation:** Split into 3 plans: (1) migration code with tests, (2) documentation rewrite (user guide + dev docs + examples), (3) companion skill + gate cleanup + CLI reference update.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Lazy migration on task load: detect gate format, convert to DAG, write back to disk
- One-time conversion per task -- next load sees DAG format natively
- In-flight gate tasks get migrated with position mapping: current gate step maps to equivalent hop status, task continues from where it was
- Gate evaluation code kept with deprecation markers (not removed) -- safety net for edge cases, remove in v1.3
- Dual-mode evaluator (Phase 12) remains as fallback during migration period
- Replace gate docs entirely: delete workflow-gates.md and custom-gates.md, create new workflow-dags.md
- Tutorial-style approach: conceptual overview -> step-by-step "create your first DAG workflow" walkthrough -> reference section for all hop options
- Rewrite all 3 existing examples (simple-review.yaml, swe-sdlc.yaml, sales-pipeline.yaml) from gate format to DAG format
- Add 1-2 new examples showing DAG-specific features (conditional branching, parallel hops)
- Replace workflow-gates-design.md with DAG design doc
- Cover: schema model, evaluator pipeline, condition DSL, extension points (adding operators, custom hop types)
- Single SKILL.md file at project root -- agents read it when working with AOF
- Teach: how to use --workflow flag for templates, how to compose ad-hoc DAGs in YAML frontmatter, common patterns (linear, review-cycle, parallel-fan-out), pitfalls to avoid
- Include brief "if you encounter gate-format" section explaining auto-migration and that agents should use DAG format for new tasks
- Full cleanup in documentation: all gate references replaced with DAG equivalents across ~14 doc files
- Source code: keep gate evaluation code with deprecation markers, don't remove
- Update migration.md with gate->DAG migration section for users upgrading from v1.1
- CLI reference: ensure auto-gen picks up --workflow flag from Phase 14, no new CLI commands needed
- Document existing CLI commands only (no new bd workflow subcommands)

### Claude's Discretion
- Exact DAG example scenarios beyond the 3 rewrites
- Companion skill example count and complexity progression
- Deprecation marker format in source code
- migration.md section length and detail level

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SAFE-05 | Existing linear gate workflows can be lazily migrated to equivalent DAG format | Migration hook in task-store.ts load path; gate schema -> DAG schema mapping; in-flight position mapping via gate.current -> hop state |
| DOCS-01 | User guide updated with workflow DAG concepts, authoring, and monitoring | Replace workflow-gates.md + custom-gates.md with workflow-dags.md; tutorial-style approach with reference tables |
| DOCS-02 | Developer docs updated with DAG schema reference, evaluator internals, and extension points | Replace workflow-gates-design.md with DAG architecture doc covering schema, evaluator, condition DSL, extension |
| DOCS-03 | AOF companion skill updated to teach agents how to compose workflow DAGs | Rewrite skills/aof/SKILL.md "Workflow Gates" section with DAG patterns, --workflow flag, ad-hoc YAML examples |
| DOCS-04 | Outdated gate references removed from companion skill and documentation | 30 files with 787 gate references; categorized by replacement type (full replace vs. targeted edit) |
| DOCS-05 | Auto-generated CLI reference updated with any new workflow commands | Run `npm run docs:generate` after build; --workflow flag already in Commander tree, just needs regen |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | existing | Schema validation for migrated tasks | Already used for TaskFrontmatter, WorkflowDefinition, TaskWorkflow |
| write-file-atomic | existing | Atomic task file writes during migration | Already used in task-store.ts for all task mutations |
| yaml | existing | YAML parsing for frontmatter | Already used in task-parser.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| commander.js | existing | CLI command tree for docs:generate | Auto-gen CLI reference walks Commander tree |

### Alternatives Considered
None -- zero new dependencies. All migration and documentation work uses existing libraries.

**Installation:**
No new packages needed.

## Architecture Patterns

### Migration Hook Location

The migration intercepts the task load path. The `FilesystemTaskStore.get()` and `FilesystemTaskStore.list()` methods both call `parseTaskFile()` which returns parsed frontmatter. The migration hook should be placed after parsing, before returning the task.

```
task-store.ts::get()
  -> readFile()
  -> parseTaskFile()    // returns Task with gate or workflow fields
  -> migrateGateToDAG() // NEW: detect gate, convert, write back
  -> return task
```

### Gate-to-DAG Mapping

Source: Existing schema definitions in `src/schemas/gate.ts` and `src/schemas/workflow-dag.ts`

The mapping is mechanical:

| Gate Field | DAG Equivalent |
|-----------|----------------|
| `workflow.gates[i]` | `workflow.definition.hops[i]` |
| `gate.id` | `hop.id` |
| `gate.role` | `hop.role` |
| `gate.canReject` | `hop.canReject` |
| `gate.when` (string expr) | `hop.condition` (JSON DSL) -- requires conversion |
| `gate.timeout` | `hop.timeout` |
| `gate.escalateTo` | `hop.escalateTo` |
| `gate.description` | `hop.description` |
| Linear order (array index) | `hop.dependsOn` (each hop depends on previous) |
| `rejectionStrategy: origin` | `hop.rejectionStrategy: "origin"` on each canReject hop |

### In-Flight Position Mapping

For tasks with an active `gate.current`:

| Gate State | DAG State |
|-----------|-----------|
| Gates before `current` | `status: "complete"` |
| Gate at `current` position | Preserve current task status: if `in-progress` -> `dispatched`, if `review` -> `complete` with `autoAdvance: false` |
| Gates after `current` | `status: "pending"` |

### Gate Condition Conversion

Gate `when` expressions are string-based JavaScript predicates:
```
"tags.includes('security') || tags.includes('auth')"
```

DAG conditions use JSON DSL:
```json
{ "op": "or", "conditions": [
  { "op": "has_tag", "value": "security" },
  { "op": "has_tag", "value": "auth" }
]}
```

Common patterns to handle:
- `tags.includes('X')` -> `{ "op": "has_tag", "value": "X" }`
- `!tags.includes('X')` -> `{ "op": "not", "condition": { "op": "has_tag", "value": "X" } }`
- `||` combinations -> `{ "op": "or", "conditions": [...] }`
- `&&` combinations -> `{ "op": "and", "conditions": [...] }`
- `metadata.X > N` -> `{ "op": "gt", "field": "metadata.X", "value": N }`

For complex/unparseable `when` expressions, the migration should log a warning and skip the condition (hop always activates). This is safer than silently breaking logic.

### Deprecation Marker Pattern

For gate source code files (~15 files), add JSDoc deprecation markers:

```typescript
/**
 * @deprecated Since v1.2. Gate evaluation is superseded by DAG evaluation.
 * Kept for backward compatibility during migration period. Will be removed in v1.3.
 * @see dag-evaluator.ts for the current implementation.
 */
```

### Documentation Structure

**User Guide (docs/guide/):**
```
workflow-dags.md          # NEW: replaces workflow-gates.md + custom-gates.md
  - Overview (what are workflow DAGs)
  - Quick Start (create first DAG workflow)
  - Hop Types and Properties (reference table)
  - Condition DSL Reference
  - Timeout and Escalation
  - Rejection and Recovery
  - Template Workflows
  - Ad-hoc Workflows
  - Best Practices
  - Troubleshooting
migration.md              # UPDATED: add gate->DAG section
```

**Developer Docs (docs/dev/):**
```
workflow-dag-design.md    # NEW: replaces workflow-gates-design.md
  - Architecture Overview
  - Schema Model (Zod types)
  - Evaluator Pipeline (evaluateDAG internals)
  - Condition DSL (operators, extension)
  - State Machine (HopStatus lifecycle)
  - Extension Points (adding operators, custom hop types)
  - Template Registry
  - Migration Internals
```

**Examples (docs/examples/):**
```
simple-review.yaml        # REWRITTEN: gate -> DAG format
swe-sdlc.yaml            # REWRITTEN: gate -> DAG format
sales-pipeline.yaml       # REWRITTEN: gate -> DAG format
parallel-review.yaml      # NEW: demonstrates parallel hops
conditional-branching.yaml # NEW: demonstrates conditional branching
```

### Pre-commit Hook Implications

The `scripts/check-docs.mjs` pre-commit hook enforces:
1. CLI reference matches auto-generated output
2. All Commander commands have doc headings
3. No broken internal links
4. README freshness

When deleting `workflow-gates.md` and `custom-gates.md`, all internal links pointing to these files must be updated. The broken-link checker (check 3) will catch any missed references.

When regenerating CLI reference, the stale-docs checker (check 1) will require the committed file to match the fresh output.

### CLI Reference Regeneration

The `--workflow` flag was added to `aof task create` in Phase 14 (line 26 of `src/cli/commands/task.ts`). The auto-gen script at `scripts/generate-cli-docs.mjs` walks the Commander tree. To update CLI reference:

1. `npm run build` (compile TypeScript to dist/)
2. `npm run docs:generate` (regenerate docs/guide/cli-reference.md)
3. Commit the updated file

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| DAG state initialization | Custom state builder | `initializeWorkflowState()` | Already handles root hop detection and state derivation |
| DAG validation | Manual cycle detection | `validateDAG()` | Already implements Kahn's algorithm, reachability, condition complexity |
| Task serialization | Custom YAML writer | `serializeTask()` | Already handles frontmatter/body split with proper YAML formatting |
| Atomic file writes | fs.writeFile | `write-file-atomic` | Already used throughout for crash-safe writes |
| CLI docs generation | Manual doc editing | `npm run docs:generate` | Auto-gen from Commander tree is the established pattern |

## Common Pitfalls

### Pitfall 1: Mutually Exclusive Gate/Workflow Fields
**What goes wrong:** TaskFrontmatter has a `superRefine` that errors if both `gate` and `workflow` fields are present on the same task.
**Why it happens:** During migration, if you set the `workflow` field without clearing `gate`, `gateHistory`, and `reviewContext`, the Zod parse will fail.
**How to avoid:** Migration MUST clear all gate-related fields (`gate`, `gateHistory`, `reviewContext`, `tests`, `testsFile`) when setting the `workflow` field.
**Warning signs:** Zod validation errors about "Task cannot have both 'gate' and 'workflow' fields."

### Pitfall 2: In-Flight Task State Loss
**What goes wrong:** A task mid-workflow (e.g., at gate 3 of 5) loses its position during migration.
**Why it happens:** Naive migration creates all hops as "pending" instead of mapping the current gate position.
**How to avoid:** Use gate.current to determine which hops should be marked complete vs. pending vs. dispatched. The mapping table in Architecture Patterns covers this.
**Warning signs:** Tasks restart from the beginning of their workflow after migration.

### Pitfall 3: Condition Expression Conversion Failures
**What goes wrong:** Gate `when` strings contain arbitrary JavaScript that can't be mechanically converted to JSON DSL.
**Why it happens:** Gate conditions were string-based JS predicates with no restrictions. Some may use complex expressions.
**How to avoid:** Handle common patterns (tags.includes, metadata comparisons) and log a warning for unrecognized patterns. Skip the condition (hop always activates) rather than producing incorrect DSL.
**Warning signs:** Tasks with conditional gates that suddenly skip or execute gates they shouldn't.

### Pitfall 4: Broken Internal Links After Doc Deletion
**What goes wrong:** Deleting workflow-gates.md and custom-gates.md breaks internal links across ~14 other doc files.
**Why it happens:** Many docs cross-reference these files.
**How to avoid:** Update all internal links to point to the new workflow-dags.md before deleting old files. The pre-commit hook's broken-link checker will catch any missed references.
**Warning signs:** Pre-commit hook failure on check 3 (broken internal links).

### Pitfall 5: Stale CLI Reference
**What goes wrong:** The pre-commit hook fails because cli-reference.md doesn't match the auto-generated output.
**Why it happens:** The `--workflow` flag was added in Phase 14 code but the docs weren't regenerated.
**How to avoid:** Run `npm run build && npm run docs:generate` and commit the result.
**Warning signs:** Pre-commit hook failure on check 1 (stale generated docs).

### Pitfall 6: Migration Writes Interfering with Active Scheduler
**What goes wrong:** Migration writes to task files while the scheduler is reading them, causing race conditions.
**Why it happens:** Both the scheduler poll cycle and migration use `write-file-atomic`, but the migration changes the task shape (adds `workflow`, removes `gate`).
**How to avoid:** Migration happens lazily on load -- it's a single atomic write per task. The scheduler already re-reads tasks fresh before dispatch (Phase 12 decision). No additional synchronization needed since `write-file-atomic` provides rename-based atomicity.
**Warning signs:** None expected -- the existing write-file-atomic pattern handles this.

### Pitfall 7: WorkflowConfig vs TaskWorkflow Confusion
**What goes wrong:** Migration code confuses `WorkflowConfig` (project.yaml gate-format) with `TaskWorkflow` (frontmatter DAG-format).
**Why it happens:** The codebase has three workflow-related schemas: `WorkflowConfig` (gate workflow in project.yaml), `WorkflowDefinition` (DAG definition), and `TaskWorkflow` (DAG on task frontmatter).
**How to avoid:** Migration reads gate fields from task frontmatter (`gate`, `gateHistory`, gate definitions from `WorkflowConfig`), NOT from the project manifest. Each task carries its own gate state. If the task references a `routing.workflow` name, look up the `WorkflowConfig` from the project manifest to get the gate definitions.
**Warning signs:** Migration fails to find gate definitions because it's looking in the wrong place.

## Code Examples

### Migration Function

```typescript
// Source: Derived from existing schemas (gate.ts, workflow-dag.ts, task.ts)
import { TaskWorkflow, WorkflowDefinition, initializeWorkflowState } from "../schemas/workflow-dag.js";
import type { Task } from "../schemas/task.js";
import type { WorkflowConfig } from "../schemas/workflow.js";

/**
 * @deprecated Gate-to-DAG migration helper. Remove in v1.3.
 */
export function migrateGateToDAG(
  task: Task,
  workflowConfig: WorkflowConfig,
): Task {
  if (!task.frontmatter.gate || task.frontmatter.workflow) {
    return task; // No gate state or already DAG -- skip
  }

  // Convert gate sequence to hop definitions
  const hops = workflowConfig.gates.map((gate, index) => ({
    id: gate.id,
    role: gate.role,
    dependsOn: index > 0 ? [workflowConfig.gates[index - 1]!.id] : [],
    autoAdvance: true,
    canReject: gate.canReject ?? false,
    rejectionStrategy: gate.canReject ? ("origin" as const) : undefined,
    description: gate.description,
    timeout: gate.timeout,
    escalateTo: gate.escalateTo,
    // Note: gate.when string conditions need conversion to JSON DSL
    // Complex conditions are skipped with a warning
  }));

  const definition: WorkflowDefinition = {
    name: workflowConfig.name,
    hops,
  };

  // Initialize state and map in-flight position
  const state = initializeWorkflowState(definition);
  const currentGateId = task.frontmatter.gate.current;
  const currentIndex = workflowConfig.gates.findIndex(g => g.id === currentGateId);

  if (currentIndex >= 0) {
    // Mark completed gates
    for (let i = 0; i < currentIndex; i++) {
      const hopId = workflowConfig.gates[i]!.id;
      state.hops[hopId] = { status: "complete" };
    }
    // Mark current gate based on task status
    if (task.frontmatter.status === "in-progress") {
      state.hops[currentGateId] = { status: "dispatched" };
    } else {
      state.hops[currentGateId] = { status: "ready" };
    }
    state.status = "running";
    state.startedAt = task.frontmatter.gate.entered;
  }

  // Set workflow field
  task.frontmatter.workflow = {
    definition,
    state,
  };

  // Clear gate fields (mutually exclusive with workflow)
  task.frontmatter.gate = undefined;
  task.frontmatter.gateHistory = [];
  task.frontmatter.reviewContext = undefined;

  return task;
}
```

### DAG Example Format (simple-review rewrite)

```yaml
# Simple Review Workflow (DAG format)
#
# Minimal workflow: implement -> review with rejection capability.
# Equivalent to the gate-format simple-review but using DAG hops.

name: simple-review
hops:
  - id: implement
    role: developer
    description: "Implement the feature or fix with tests"
    # Root hop: no dependsOn (starts immediately)

  - id: review
    role: reviewer
    dependsOn: [implement]
    canReject: true
    rejectionStrategy: origin
    description: "Review code quality, tests, and correctness"
    autoAdvance: true
```

### Deprecation Marker Example

```typescript
/**
 * Gate evaluation algorithm -- deterministic state machine for task progression.
 *
 * @deprecated Since v1.2. Gate evaluation is superseded by DAG evaluation
 * (see dag-evaluator.ts). This module is preserved as a fallback during the
 * gate-to-DAG migration period. It will be removed in v1.3.
 *
 * For new workflow implementations, use the DAG evaluator:
 * @see {evaluateDAG} from "./dag-evaluator.js"
 *
 * @module gate-evaluator
 */
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Linear gate sequence | DAG-based workflow hops | v1.2 (Phases 10-14) | Tasks can now have parallel, conditional, and non-linear workflows |
| String-based JS conditions (`when`) | JSON DSL conditions (`condition`) | v1.2 (Phase 11) | Safe agent-composed conditions without eval() |
| Gate state (current + history) | Hop state map (per-hop status) | v1.2 (Phase 10) | O(1) hop lookup, richer state per hop |
| WorkflowConfig in project.yaml | WorkflowDefinition + templates | v1.2 (Phase 14) | Templates can be named, ad-hoc workflows on task creation |

**Deprecated/outdated:**
- `WorkflowConfig` / gate-based `workflow` field in project.yaml: Superseded by `workflowTemplates` (DAG definitions)
- `gate`, `gateHistory`, `reviewContext` on task frontmatter: Superseded by `workflow` (TaskWorkflow)
- `gate-evaluator.ts`, `gate-transition-handler.ts`, `gate-context-builder.ts`, `gate-conditional.ts`: Superseded by DAG equivalents; kept with deprecation markers

## Files Inventory

### Files to Create
| File | Purpose |
|------|---------|
| `src/migration/gate-to-dag.ts` | Migration logic (gate detection, DAG conversion, position mapping) |
| `src/migration/__tests__/gate-to-dag.test.ts` | Migration tests |
| `docs/guide/workflow-dags.md` | New user guide (replaces workflow-gates.md + custom-gates.md) |
| `docs/dev/workflow-dag-design.md` | New developer docs (replaces workflow-gates-design.md) |
| `docs/examples/parallel-review.yaml` | New example: parallel DAG hops |
| `docs/examples/conditional-branching.yaml` | New example: conditional branching |

### Files to Rewrite
| File | What Changes |
|------|-------------|
| `docs/examples/simple-review.yaml` | Gate format -> DAG format |
| `docs/examples/swe-sdlc.yaml` | Gate format -> DAG format |
| `docs/examples/sales-pipeline.yaml` | Gate format -> DAG format |
| `skills/aof/SKILL.md` | Replace "Workflow Gates" section with DAG patterns, --workflow flag, ad-hoc examples |

### Files to Update (gate reference cleanup)
| File | Gate Refs | Change Type |
|------|-----------|-------------|
| `docs/guide/task-lifecycle.md` | 7 | Replace gate mentions with DAG/hop terminology |
| `docs/guide/getting-started.md` | 6 | Update link to workflow-dags.md, terminology |
| `docs/guide/agent-tools.md` | 12 | Update gate outcome docs to include DAG hop context |
| `docs/guide/configuration.md` | 11 | Update workflow config references |
| `docs/guide/deployment.md` | 20 | Update workflow-related deployment notes |
| `docs/guide/org-charts.md` | 9 | Update role-gate mapping to role-hop mapping |
| `docs/guide/cli-reference.md` | 5 | Regenerate via `npm run docs:generate` |
| `docs/guide/known-issues.md` | 5 | Update gate-related known issues |
| `docs/guide/recovery.md` | 3 | Update recovery procedures for DAG tasks |
| `docs/guide/cascading-dependencies.md` | 2 | Minor terminology update |
| `docs/guide/migration.md` | 0 (new section) | Add gate->DAG migration section |
| `docs/dev/architecture.md` | 10 | Update architecture overview with DAG flow |
| `docs/dev/e2e-test-harness.md` | 80 | Update test scenario references |
| `docs/README.md` | 8 | Update doc index links |

### Files to Delete
| File | Reason |
|------|--------|
| `docs/guide/workflow-gates.md` | Replaced by workflow-dags.md |
| `docs/guide/custom-gates.md` | Replaced by workflow-dags.md |
| `docs/dev/workflow-gates-design.md` | Replaced by workflow-dag-design.md |

### Source Files to Add Deprecation Markers
| File | Purpose |
|------|---------|
| `src/dispatch/gate-evaluator.ts` | Core gate evaluation logic |
| `src/dispatch/gate-transition-handler.ts` | Gate state transitions |
| `src/dispatch/gate-context-builder.ts` | Gate context for agents |
| `src/dispatch/gate-conditional.ts` | Gate condition evaluation |
| `src/schemas/gate.ts` | Gate type definitions |
| `src/schemas/workflow.ts` | Gate-based WorkflowConfig |

## Open Questions

1. **How to handle tasks with `routing.workflow` pointing to a gate-format WorkflowConfig in project.yaml**
   - What we know: Tasks reference a workflow by name; the WorkflowConfig lives in project.yaml's `workflow` field
   - What's unclear: Should migration also convert the project.yaml `workflow` (gate-format) to a `workflowTemplates` entry (DAG-format)?
   - Recommendation: Yes, but only when a task triggers migration. The project manifest's `workflow` field stays as-is (it's the source for migration). New tasks use `workflowTemplates`. Document this in migration.md.

2. **Complex gate `when` expressions that can't be auto-converted**
   - What we know: Most gate conditions use `tags.includes()` or `metadata.X > N` patterns
   - What's unclear: Are there any gate conditions in the wild that use truly complex JS?
   - Recommendation: Handle the documented patterns, log a warning for unrecognized expressions, skip the condition (hop always activates). Users can manually add the JSON DSL condition after migration.

## Sources

### Primary (HIGH confidence)
- `src/schemas/task.ts` - TaskFrontmatter with gate/workflow mutual exclusivity superRefine
- `src/schemas/workflow-dag.ts` - WorkflowDefinition, TaskWorkflow, validateDAG, initializeWorkflowState
- `src/schemas/gate.ts` - Gate, GateHistoryEntry, ReviewContext, TestSpec schemas
- `src/schemas/workflow.ts` - WorkflowConfig (gate-format), validateWorkflow
- `src/schemas/project.ts` - ProjectManifest with workflowTemplates
- `src/store/task-store.ts` - FilesystemTaskStore.get() and .list() load paths
- `src/dispatch/scheduler.ts` - Dual-mode gate/DAG dispatch
- `src/dispatch/dag-transition-handler.ts` - DAG dispatch and completion handling
- `scripts/generate-cli-docs.mjs` - CLI reference auto-generation
- `scripts/check-docs.mjs` - Pre-commit doc validation (4 checks)
- `docs/guide/workflow-gates.md` - Current user guide (to be replaced)
- `docs/guide/custom-gates.md` - Current customization guide (to be replaced)
- `docs/dev/workflow-gates-design.md` - Current design doc (to be replaced)
- `docs/examples/*.yaml` - Current gate-format examples (to be rewritten)
- `skills/aof/SKILL.md` - Current companion skill (to be updated)

### Secondary (MEDIUM confidence)
- Gate reference grep across 30 doc files - count and file identification
- Pre-commit hook behavior verification via check-docs.mjs source

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - zero new dependencies, all existing patterns
- Architecture: HIGH - migration hook location and gate-to-DAG mapping are mechanically determined from schema comparison
- Pitfalls: HIGH - identified from direct code inspection of mutually exclusive field validation, in-flight state, and pre-commit hooks

**Research date:** 2026-03-03
**Valid until:** 2026-04-03 (stable -- no external dependency changes expected)
