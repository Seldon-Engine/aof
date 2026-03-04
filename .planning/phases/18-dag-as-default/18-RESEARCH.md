# Phase 18: DAG-as-Default - Research

**Researched:** 2026-03-03
**Domain:** CLI option handling, project manifest resolution, Commander.js --no-* patterns
**Confidence:** HIGH

## Summary

Phase 18 is a well-scoped CLI feature change with minimal blast radius. The core task is modifying the `task create` command handler in `src/cli/commands/task.ts` to auto-resolve the project's `defaultWorkflow` when no explicit `--workflow` flag is provided, and adding a `--no-workflow` flag to opt out. All building blocks already exist: `resolveWorkflowTemplate()` resolves template names to workflow definitions, `ProjectManifest.defaultWorkflow` field is already in the schema (added by migration 001 in Phase 17), and `store.create()` already accepts an optional `workflow` parameter.

The implementation is a straightforward conditional in the create action handler: check for `--no-workflow` first (opt-out), then check for explicit `--workflow <name>`, then fall back to loading `defaultWorkflow` from the project manifest. The only new code needed is a function to load the manifest and read the `defaultWorkflow` field, plus graceful handling when `project.yaml` doesn't exist (the `_inbox` project has no manifest).

**Primary recommendation:** Add `--no-workflow` option via Commander's built-in negation pattern, create a `resolveDefaultWorkflow(projectRoot)` function in `task-create-workflow.ts`, and wire the three-way precedence logic into the create action handler.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- `--workflow <name>` (explicit template) takes highest priority -- overrides defaultWorkflow
- `--no-workflow` suppresses defaultWorkflow attachment, creates bare task
- No flags + defaultWorkflow configured -> auto-attach defaultWorkflow
- No flags + no defaultWorkflow -> bare task (existing behavior, graceful degradation)

### Claude's Discretion
- Whether `--workflow` and `--no-workflow` conflict should be an error or `--no-workflow` wins
- Output feedback on workflow attachment (silent vs confirmation line)
- Error handling when `defaultWorkflow` references a nonexistent template (fail loudly vs warn and create bare)
- Test approach and scope

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DAGD-01 | `bd create` auto-attaches the project's `defaultWorkflow` template when no `--workflow` flag is specified | Manifest already has `defaultWorkflow` field (z.string().optional()); `resolveWorkflowTemplate()` already resolves template names; create handler just needs a fallback path |
| DAGD-02 | `--no-workflow` flag on `bd create` allows opting out of the default workflow for bare tasks | Commander v14 supports `--no-*` negation pattern natively; existing codebase uses this pattern in `--no-lockfile` and `--no-orphans` |
| DAGD-03 | Tasks created without a configured `defaultWorkflow` continue to work as bare tasks (graceful degradation) | `_inbox` project has no `project.yaml` at all; new function must handle ENOENT gracefully by returning undefined |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| commander | 14.0.3 | CLI option parsing, `--no-*` negation | Already used throughout; built-in `--no-*` support |
| zod | (project dep) | Schema validation for ProjectManifest | Already validates `defaultWorkflow: z.string().optional()` |
| yaml | (project dep) | YAML parsing for project.yaml | Already used in `resolveWorkflowTemplate()` |
| vitest | ^3.0.0 | Test framework | Already configured in `vitest.config.ts` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:fs/promises | built-in | File I/O for reading project.yaml | Already used in `task-create-workflow.ts` |
| node:path | built-in | Path resolution for project manifest | Already used throughout |

### Alternatives Considered
None -- all dependencies are already in the project.

## Architecture Patterns

### Recommended Project Structure

No new files needed. Changes touch two existing files:

```
src/cli/commands/
  task.ts                        # Add --no-workflow option, add defaultWorkflow resolution logic
  task-create-workflow.ts        # Add resolveDefaultWorkflow() function
src/cli/commands/__tests__/
  task-create-workflow.test.ts   # Extend with defaultWorkflow tests
```

### Pattern 1: Commander --no-* Negation for Opt-Out

**What:** Commander v14 supports defining `--no-<option>` alongside `--<option> <value>` to create a negatable value option. When `--no-workflow` is passed, `opts.workflow` becomes `false`.

**When to use:** When an option has a value form but also needs a boolean negation.

**Critical detail:** The existing `.option('-w, --workflow <template>')` already defines the positive form. Adding `.option('--no-workflow', 'Create bare task (skip default workflow)')` makes Commander set `opts.workflow` to `false` when `--no-workflow` is passed.

**Type impact:** The `workflow` option type changes from `string | undefined` to `string | false | undefined`:
- `undefined` = no flag passed (use default workflow if configured)
- `string` = explicit `--workflow <name>` (use that template)
- `false` = `--no-workflow` passed (force bare task)

**Example:**
```typescript
// Source: Commander v14 Readme.md, "Other option types, negatable boolean"
// and existing codebase pattern in system-commands.ts line 20-22
task
  .command("create <title>")
  .option("-w, --workflow <template>", "Workflow template name from project manifest")
  .option("--no-workflow", "Create bare task (skip default workflow)")
  .action(async (title, opts: { workflow?: string | false; /* ... */ }) => {
    // opts.workflow === false → --no-workflow was passed
    // opts.workflow === "code-review" → --workflow code-review was passed
    // opts.workflow === undefined → no flag, check defaultWorkflow
  });
```

### Pattern 2: Default Workflow Resolution (New Function)

**What:** A new `resolveDefaultWorkflow(projectRoot)` function that loads the project manifest and resolves `defaultWorkflow` to a workflow definition, returning `undefined` if no default is configured or no manifest exists.

**When to use:** Called from the create action when `opts.workflow` is `undefined` (no explicit flag).

**Key differences from existing `resolveWorkflowTemplate()`:**
- `resolveWorkflowTemplate()` THROWS on missing template (correct for explicit `--workflow`)
- `resolveDefaultWorkflow()` returns `undefined` on missing manifest, missing field, or missing template (graceful degradation)

**Example:**
```typescript
// New function in task-create-workflow.ts
export async function resolveDefaultWorkflow(
  projectRoot: string,
): Promise<{ definition: WorkflowDefinition; templateName: string } | undefined> {
  // 1. Load project.yaml (return undefined if not found)
  let manifest: ProjectManifest;
  try {
    const projectPath = join(projectRoot, "project.yaml");
    const yaml = await readFile(projectPath, "utf-8");
    const parsed = parseYaml(yaml) as unknown;
    manifest = ProjectManifest.parse(parsed);
  } catch {
    return undefined; // No project.yaml or invalid → bare task
  }

  // 2. Check defaultWorkflow field
  const defaultName = manifest.defaultWorkflow;
  if (!defaultName) return undefined;

  // 3. Look up template in workflowTemplates
  const templates = manifest.workflowTemplates ?? {};
  const definition = templates[defaultName];
  if (!definition) {
    // defaultWorkflow references nonexistent template
    // Recommendation: warn and create bare task (see Discretion section)
    return undefined;
  }

  // 4. Validate DAG (belt-and-suspenders)
  const dagErrors = validateDAG(definition);
  if (dagErrors.length > 0) return undefined;

  return { definition, templateName: defaultName };
}
```

### Pattern 3: Three-Way Precedence in Action Handler

**What:** The create action handler checks options in priority order.

**Example:**
```typescript
// In task.ts create action handler
let workflowOpt: { definition: WorkflowDefinition; templateName: string } | undefined;

if (opts.workflow === false) {
  // --no-workflow: explicitly skip, workflowOpt stays undefined
} else if (typeof opts.workflow === "string") {
  // --workflow <name>: explicit template, use existing resolveWorkflowTemplate
  const { resolveWorkflowTemplate } = await import("./task-create-workflow.js");
  workflowOpt = await resolveWorkflowTemplate(opts.workflow, projectRoot);
} else {
  // No flag: check for defaultWorkflow
  const { resolveDefaultWorkflow } = await import("./task-create-workflow.js");
  workflowOpt = await resolveDefaultWorkflow(projectRoot);
}
```

### Anti-Patterns to Avoid

- **Reusing resolveWorkflowTemplate for defaults:** Don't call the existing `resolveWorkflowTemplate()` with `manifest.defaultWorkflow` -- it throws on errors, which is wrong for default resolution. Create a separate function with graceful degradation semantics.
- **Loading manifest twice:** The action handler already has `projectRoot`. Don't pass through `createProjectStore` -- load the manifest directly in the new function, same as `resolveWorkflowTemplate()` does.
- **Checking --workflow and --no-workflow conflict explicitly:** Commander v14 handles this naturally. If both `--workflow <name>` and `--no-workflow` are passed, Commander will use the last one specified. However, the implementation should prioritize `--no-workflow` (since `opts.workflow === false` is checked first in the if-chain), which naturally handles any edge case.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CLI option negation | Custom boolean flag parsing | Commander `--no-*` pattern | Built-in, well-tested, already used in codebase |
| Template resolution | New resolution logic | Existing `resolveWorkflowTemplate()` for explicit flags | Already handles template lookup, DAG validation, error messages |
| Workflow DAG validation | Custom validation | Existing `validateDAG()` | Already validates hop dependencies, cycles, etc. |

## Common Pitfalls

### Pitfall 1: Commander --no-* Type Confusion
**What goes wrong:** When `--no-workflow` is defined alongside `--workflow <template>`, the `workflow` option can be `string | false | undefined`. TypeScript may not catch incorrect comparisons (e.g., `if (opts.workflow)` is truthy for strings but not `false` or `undefined`).
**Why it happens:** Commander's negation changes the option type from `string | undefined` to `string | false | undefined`.
**How to avoid:** Use explicit type checks: `opts.workflow === false` for negation, `typeof opts.workflow === "string"` for value, and the `else` branch for undefined.
**Warning signs:** Tests pass but default workflow never attaches (checking `if (opts.workflow)` skips `undefined`, which should trigger default resolution).

### Pitfall 2: Missing project.yaml (ENOENT)
**What goes wrong:** `resolveDefaultWorkflow()` crashes when `project.yaml` doesn't exist (e.g., `_inbox` project which only has `tasks/` and `events/` directories, no manifest).
**Why it happens:** The current `resolveWorkflowTemplate()` reads `project.yaml` and lets ENOENT propagate as an error. For default resolution, this must be caught.
**How to avoid:** Wrap the file read in try/catch and return `undefined` on any error.
**Warning signs:** `bd create "task"` in `_inbox` project throws ENOENT error.

### Pitfall 3: defaultWorkflow References Nonexistent Template
**What goes wrong:** Migration 001 sets `defaultWorkflow` to the first template name. If the user later deletes that template from `workflowTemplates`, the reference becomes stale.
**Why it happens:** `defaultWorkflow` is just a string -- no referential integrity enforcement in the schema.
**How to avoid:** When `defaultWorkflow` references a nonexistent template, emit a warning to stderr and create a bare task. Do NOT throw an error -- users should not be blocked from creating tasks.
**Warning signs:** Tasks silently created as bare when user expects workflow.

### Pitfall 4: Forgetting Confirmation Output
**What goes wrong:** User creates a task expecting workflow attachment, but default resolution silently failed. No feedback that workflow was or wasn't attached.
**Why it happens:** Current create output only shows workflow line when `t.frontmatter.workflow` exists.
**How to avoid:** The existing output already handles this (line 58 of task.ts: `if (t.frontmatter.workflow) console.log(...)`). This pattern is sufficient -- workflow appears in output when attached, absent when not.

## Code Examples

### Current Create Handler (task.ts lines 27-38)
```typescript
// Source: src/cli/commands/task.ts:27-38
.action(async (title: string, opts: { priority: string; team?: string; agent?: string; tags?: string; project: string; workflow?: string }) => {
  const { createProjectStore } = await import("../project-utils.js");
  const root = program.opts()["root"] as string;
  const { store, projectRoot } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
  await store.init();

  // Resolve workflow template if --workflow flag provided
  let workflowOpt: { definition: import("../../schemas/workflow-dag.js").WorkflowDefinition; templateName: string } | undefined;
  if (opts.workflow) {
    const { resolveWorkflowTemplate } = await import("./task-create-workflow.js");
    workflowOpt = await resolveWorkflowTemplate(opts.workflow, projectRoot);
  }
```

### Existing --no-lockfile Pattern (system-commands.ts)
```typescript
// Source: src/cli/commands/system-commands.ts:20-22
.option("--no-lockfile", "Skip lockfile (use npm install instead of npm ci)")
.action(async (opts: { lockfile: boolean; strict: boolean }) => {
  // opts.lockfile is true by default, false when --no-lockfile passed
```

### Existing resolveWorkflowTemplate (task-create-workflow.ts)
```typescript
// Source: src/cli/commands/task-create-workflow.ts:30-60
export async function resolveWorkflowTemplate(
  templateName: string,
  projectRoot: string,
): Promise<{ definition: WorkflowDefinition; templateName: string }> {
  const projectPath = join(projectRoot, "project.yaml");
  const yaml = await readFile(projectPath, "utf-8");
  const parsed = parseYaml(yaml) as unknown;
  const manifest = ProjectManifest.parse(parsed);

  const templates = manifest.workflowTemplates ?? {};
  const definition = templates[templateName];

  if (!definition) {
    const available = Object.keys(templates).join(", ");
    throw new Error(
      `Workflow template "${templateName}" not found in project manifest. Available: ${available || "(none)"}`,
    );
  }

  const dagErrors = validateDAG(definition);
  if (dagErrors.length > 0) {
    throw new Error(
      `Workflow template "${templateName}" has invalid DAG: ${dagErrors.join(", ")}`,
    );
  }

  return { definition, templateName };
}
```

### ProjectManifest Schema (defaultWorkflow field)
```typescript
// Source: src/schemas/project.ts:138-141
/** Named workflow templates -- static WorkflowDefinition snapshots reusable across tasks. */
workflowTemplates: z.record(TemplateNameKey, WorkflowDefinition).optional(),
/** Default workflow template name (references a key in workflowTemplates). */
defaultWorkflow: z.string().optional(),
```

### Existing Test Pattern (task-create-workflow.test.ts)
```typescript
// Source: src/cli/commands/__tests__/task-create-workflow.test.ts
// Tests use: mkdtemp for temp dirs, writeFile for project.yaml, FilesystemTaskStore
// Pattern: create temp dir → write manifest YAML → call function → assert
```

## Discretion Recommendations

These are Claude's discretion items from CONTEXT.md with research-backed recommendations:

### 1. --workflow and --no-workflow Conflict
**Recommendation: Let Commander handle it naturally (last flag wins).**
Commander v14 processes options left-to-right. If user passes `--workflow code-review --no-workflow`, opts.workflow becomes `false`. If they pass `--no-workflow --workflow code-review`, opts.workflow becomes `"code-review"`. This is standard Commander behavior. Adding explicit conflict detection adds complexity for an edge case that Commander already handles sensibly.

### 2. Output Feedback on Workflow Attachment
**Recommendation: Keep current behavior (show workflow line when present, omit when absent).**
The existing output at task.ts:58 (`if (t.frontmatter.workflow) console.log(...)`) already provides the right feedback. When a default workflow is attached, the workflow line appears. When bare, it doesn't. Adding a `(default)` annotation to the workflow line would be a nice touch: `Workflow: code-review (default)` vs `Workflow: code-review`. This helps users distinguish explicit from default attachment.

### 3. Error Handling for Stale defaultWorkflow
**Recommendation: Warn to stderr and create bare task.**
When `defaultWorkflow` references a nonexistent template, the function should `console.error()` a warning and return `undefined`. This prevents blocking task creation while alerting the user. Example: `Warning: defaultWorkflow "missing-template" not found in workflowTemplates. Creating bare task.`

### 4. Test Approach
**Recommendation: Extend existing `task-create-workflow.test.ts` with new test group.**
The existing test file already has the scaffolding (temp dirs, manifest writing, store creation). Add a `describe("resolveDefaultWorkflow")` block with cases for:
- Project with defaultWorkflow set -> resolves correctly
- Project with defaultWorkflow referencing missing template -> returns undefined
- Project without defaultWorkflow field -> returns undefined
- Project without project.yaml -> returns undefined
- End-to-end: create task with default workflow attached

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Gate-based tasks | DAG workflow tasks | v1.2 (Phase 10-16) | All new tasks can have workflow DAGs |
| Explicit --workflow only | Default workflow + --no-workflow opt-out | v1.3 (Phase 18) | Tasks auto-get workflows in configured projects |

## Open Questions

None -- the implementation path is clear. All building blocks exist, the Commander pattern is well-documented and already used in the codebase, and the requirements are specific enough to proceed directly to planning.

## Sources

### Primary (HIGH confidence)
- `src/cli/commands/task.ts` - Current create action handler (lines 19-60)
- `src/cli/commands/task-create-workflow.ts` - Existing template resolution (full file, 60 lines)
- `src/schemas/project.ts` - ProjectManifest schema with defaultWorkflow field (line 140)
- `src/store/task-store.ts` - store.create() method signature (line 172)
- `src/cli/commands/system-commands.ts:20-22` - Existing --no-lockfile pattern
- `src/cli/commands/memory.ts:413-421` - Existing --no-orphans pattern
- `node_modules/commander/Readme.md` - Commander v14 --no-* negation docs
- `src/cli/commands/__tests__/task-create-workflow.test.ts` - Existing test patterns

### Secondary (MEDIUM confidence)
- [Commander.js README - Negatable boolean options](https://github.com/tj/commander.js#other-option-types-negatable-boolean-and-booleanvalue)
- [Commander.js Issue #979 - --no-* default behavior](https://github.com/tj/commander.js/issues/979)

### Tertiary (LOW confidence)
None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already in use, no new dependencies
- Architecture: HIGH - Clear precedence logic, existing patterns to follow, two files to modify
- Pitfalls: HIGH - Well-understood edge cases (ENOENT, stale refs, type narrowing)

**Research date:** 2026-03-03
**Valid until:** 2026-04-03 (stable -- no external dependencies changing)
