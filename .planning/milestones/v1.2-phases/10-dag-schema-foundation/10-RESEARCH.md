# Phase 10: DAG Schema Foundation - Research

**Researched:** 2026-03-02
**Domain:** Zod schema design for workflow DAGs, graph validation, execution state modeling
**Confidence:** HIGH

## Summary

Phase 10 defines all data shapes for the per-task workflow DAG system. The scope is schema-only: Zod type definitions, creation-time validation (cycle detection, reachability, unique IDs), execution state structures, and backward-compatible integration with existing TaskFrontmatter. No runtime logic (evaluator, scheduler, dispatcher) is in scope -- those are Phases 11-12.

The existing codebase provides strong precedent. Gate schemas (`gate.ts`), workflow config (`workflow.ts`), task frontmatter (`task.ts`), and the validation pattern (`validateWorkflow()`) establish conventions for optional fields, `.default()` usage, validation-as-string-array-returns, and barrel exports via `index.ts`. The user's CONTEXT.md locks key decisions: the top-level field is named `workflow` (split into `workflow.definition` and `workflow.state`), edges use per-hop `dependsOn` arrays, hop state is a map keyed by hop ID, and gate+DAG fields are mutually exclusive on a task.

**Primary recommendation:** Create a single new file `src/schemas/workflow-dag.ts` containing all DAG schemas (Hop, WorkflowDefinition, HopState, WorkflowState, TaskWorkflow) plus a `validateDAG()` function using the same `string[]` error-return pattern as `validateWorkflow()`. Add the optional `workflow` field to TaskFrontmatter with a `.superRefine()` that rejects tasks carrying both `gate` and `workflow`. Export via `index.ts`. Zero new dependencies.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Per-hop `dependsOn` array listing predecessor hop IDs (mirrors existing task `dependsOn` pattern)
- Hops with no `dependsOn` (or empty array) are root/start hops, eligible for parallel dispatch
- DAG completion is implicit -- all hops reaching terminal state (complete/failed/skipped) = DAG done
- Per-hop `joinType: 'all' | 'any'` field for join hops with multiple predecessors; defaults to `all` (AND-join)
- Boolean `autoAdvance` per hop -- true = scheduler advances immediately on completion; false = task moves to review, awaits approval
- Inline `condition` field on each hop with JSON DSL expression (evaluated to decide execute vs skip)
- Schema placeholders for rejection behavior: `canReject` boolean and `rejectionStrategy` field -- actual logic implemented in Phase 13
- Optional `description` field for human/agent readability (zero cost if omitted)
- Optional `timeout` and `escalateTo` fields (schema defined here, timeout behavior in Phase 13)
- Top-level frontmatter field named `workflow` containing both definition and state
- Split into `workflow.definition` (immutable DAG shape set at creation) and `workflow.state` (mutable execution progress)
- Per-hop state stored as map of hop ID to state object (not array) for fast lookup
- Each hop state carries: `status` (pending/ready/dispatched/complete/failed/skipped), `startedAt`, `completedAt`, `agent`, `correlationId`, `result` (arbitrary output data)
- Persisted `workflow.state.status` field (pending/running/complete/failed) for quick DAG-level inspection without scanning all hops
- Stay at `schemaVersion: 1` -- `workflow` field is additive and optional
- Gate-based (`gate`/`gateHistory`) and DAG-based (`workflow`) fields are mutually exclusive on a task; validation rejects tasks with both
- WorkflowDAG definition schema designed to be reusable -- same Zod schema works inline on task frontmatter AND as named template in project config (Phase 14 adds template registry)

### Claude's Discretion
- Exact Zod schema field ordering and nesting details
- Cycle detection and validation algorithm internals
- How the condition JSON DSL schema is structured in Zod (Phase 11 evaluator will consume it)
- Error message wording for validation failures
- Whether to use Zod refinements, transforms, or superRefine for cross-field validation

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DAG-01 | Task can carry a workflow DAG definition with typed hops and edges | Hop and WorkflowDefinition Zod schemas; optional `workflow` field on TaskFrontmatter; `dependsOn` edge model per user decision |
| DAG-02 | Each hop specifies target role/agent, conditions, timeout, and auto-advance vs review behavior | Hop schema with `role`, `condition`, `timeout`, `escalateTo`, `autoAdvance`, `canReject`, `rejectionStrategy`, `joinType`, `description` fields |
| DAG-03 | DAG execution state (hop statuses, current position) persists on task frontmatter atomically | `workflow.state` schema: HopState map keyed by hop ID with full lifecycle statuses; `workflow.state.status` for DAG-level status; atomic writes via existing writeFileAtomic pattern |
| DAG-04 | Workflow DAG is validated on creation (cycle detection, unreachable hops, missing roles) | `validateDAG()` function using Kahn's algorithm for cycle detection, BFS/DFS for reachability, hop ID uniqueness, `dependsOn` reference validation |
| EXEC-08 | Hop lifecycle follows state machine: pending -> ready -> dispatched -> complete/failed/skipped | HopStatus enum with 6 states matching user decision; HopState schema with status + timestamps + metadata for each lifecycle phase |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `zod` | ^3.24.0 (installed: 3.25.76) | Schema definitions, parse-time validation, `.superRefine()` for graph validation | Already used for all AOF schemas. `.superRefine()` supports custom validation with full issue control |
| `yaml` | ^2.7.0 | YAML frontmatter serialization (existing) | Already used by task-parser.ts for frontmatter round-trip |
| `write-file-atomic` | ^7.0.0 | Atomic file writes for crash-safe state persistence | Already used throughout codebase for all task mutations |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | ^3.0.0 | Unit tests for schema validation, DAG validation, mutual exclusivity | Already configured with test patterns at `src/**/__tests__/**/*.test.ts` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled cycle detection | `graphlib` npm package | Adds dependency for 30 lines of Kahn's algorithm; AOF DAGs are small (5-20 hops); zero-dep decision is locked |
| Zod `.superRefine()` for graph validation | Separate validate function | `.superRefine()` integrates with parse pipeline but loses control over error ordering; standalone `validateDAG()` matches existing `validateWorkflow()` pattern -- use both |

**Installation:**
```bash
# No new packages needed. All dependencies already installed.
```

## Architecture Patterns

### Recommended File Structure
```
src/schemas/
  workflow-dag.ts       # NEW: All DAG schemas (Hop, WorkflowDefinition, HopState, WorkflowState, TaskWorkflow) + validateDAG()
  task.ts               # MODIFY: Add optional `workflow` field to TaskFrontmatter, add superRefine for gate/workflow mutual exclusivity
  index.ts              # MODIFY: Export new DAG schemas
  gate.ts               # UNCHANGED: Gate schemas remain for backward compatibility
  workflow.ts           # UNCHANGED: Linear WorkflowConfig remains for backward compatibility
```

### Pattern 1: Schema Design -- Hop Definition
**What:** The Hop schema defines a single node in the workflow DAG. It mirrors the existing Gate schema but adds DAG-specific fields.
**When to use:** Defining the static workflow shape at task creation time.

```typescript
// src/schemas/workflow-dag.ts

import { z } from "zod";

/**
 * JSON DSL condition expression for hop activation.
 * Schema placeholder -- Phase 11 evaluator consumes this.
 * Structured as a recursive union of operator nodes.
 */
export const ConditionExpr: z.ZodType<ConditionExprType> = z.lazy(() =>
  z.discriminatedUnion("op", [
    // Comparison operators
    z.object({ op: z.literal("eq"), field: z.string(), value: z.unknown() }),
    z.object({ op: z.literal("neq"), field: z.string(), value: z.unknown() }),
    z.object({ op: z.literal("gt"), field: z.string(), value: z.number() }),
    z.object({ op: z.literal("gte"), field: z.string(), value: z.number() }),
    z.object({ op: z.literal("lt"), field: z.string(), value: z.number() }),
    z.object({ op: z.literal("lte"), field: z.string(), value: z.number() }),
    // Collection operators
    z.object({ op: z.literal("in"), field: z.string(), value: z.array(z.unknown()) }),
    z.object({ op: z.literal("has_tag"), value: z.string() }),
    z.object({ op: z.literal("hop_status"), hop: z.string(), status: z.string() }),
    // Logical operators (recursive)
    z.object({ op: z.literal("and"), conditions: z.array(ConditionExpr) }),
    z.object({ op: z.literal("or"), conditions: z.array(ConditionExpr) }),
    z.object({ op: z.literal("not"), condition: ConditionExpr }),
    // Literal
    z.object({ op: z.literal("true") }),
    z.object({ op: z.literal("false") }),
  ])
);

/** Hop definition -- a node in the workflow DAG. */
export const Hop = z.object({
  /** Unique hop ID within the workflow (e.g., "implement", "review", "deploy"). */
  id: z.string().min(1),
  /** Role responsible for this hop (from org chart). */
  role: z.string().min(1),
  /** Hop IDs that must complete before this hop can start. Empty = root hop. */
  dependsOn: z.array(z.string()).default([]),
  /** Join type for hops with multiple predecessors. */
  joinType: z.enum(["all", "any"]).default("all"),
  /** Whether scheduler advances immediately on completion (true) or waits for review (false). */
  autoAdvance: z.boolean().default(true),
  /** JSON DSL condition expression for hop activation (execute vs skip). */
  condition: ConditionExpr.optional(),
  /** Human-readable description. */
  description: z.string().optional(),
  /** Whether this hop can reject work back. Schema placeholder -- logic in Phase 13. */
  canReject: z.boolean().default(false),
  /** Rejection strategy. Schema placeholder -- logic in Phase 13. */
  rejectionStrategy: z.enum(["origin", "predecessors"]).optional(),
  /** Maximum time before escalation (e.g., "1h", "30m"). Schema only -- behavior in Phase 13. */
  timeout: z.string().optional(),
  /** Escalation target role on timeout. Schema only -- behavior in Phase 13. */
  escalateTo: z.string().optional(),
});
```

**Confidence:** HIGH -- directly implements locked decisions from CONTEXT.md using established Zod patterns.

### Pattern 2: Schema Design -- Workflow Definition (Immutable Shape)
**What:** The WorkflowDefinition schema wraps an array of Hops and represents the immutable DAG shape set at creation time.
**When to use:** `workflow.definition` on task frontmatter.

```typescript
/** Workflow DAG definition -- the immutable shape of the workflow. */
export const WorkflowDefinition = z.object({
  /** Workflow name (for identification and template matching). */
  name: z.string().min(1),
  /** Ordered hop definitions (order is cosmetic -- DAG structure from dependsOn). */
  hops: z.array(Hop).min(1),
});
```

**Confidence:** HIGH -- minimal schema wrapping hops array.

### Pattern 3: Schema Design -- Execution State (Mutable)
**What:** HopState and WorkflowState schemas track mutable execution progress.
**When to use:** `workflow.state` on task frontmatter, updated atomically on each hop transition.

```typescript
/** Status of a single hop in DAG execution. */
export const HopStatus = z.enum([
  "pending",      // Not yet eligible (predecessors incomplete)
  "ready",        // All predecessors complete, eligible for dispatch
  "dispatched",   // Scheduler has dispatched this hop to an agent
  "complete",     // Hop completed successfully
  "failed",       // Hop failed (agent error, timeout, etc.)
  "skipped",      // Condition evaluated to false, hop will not execute
]);

/** Runtime state of a single hop. */
export const HopState = z.object({
  /** Hop execution status. */
  status: HopStatus,
  /** ISO-8601 timestamp when hop started execution. */
  startedAt: z.string().datetime().optional(),
  /** ISO-8601 timestamp when hop completed/failed/skipped. */
  completedAt: z.string().datetime().optional(),
  /** Agent assigned to this hop (set on dispatch). */
  agent: z.string().optional(),
  /** Correlation ID for tracing (links to session/run). */
  correlationId: z.string().optional(),
  /** Arbitrary output data from hop execution (for downstream hops). */
  result: z.record(z.string(), z.unknown()).optional(),
});

/** DAG-level execution status. */
export const WorkflowStatus = z.enum([
  "pending",    // Workflow created but not yet started
  "running",    // At least one hop has been dispatched
  "complete",   // All hops in terminal state, DAG succeeded
  "failed",     // DAG failed (at least one hop failed without recovery path)
]);

/** Mutable execution state of the workflow DAG. */
export const WorkflowState = z.object({
  /** DAG-level status for quick inspection. */
  status: WorkflowStatus,
  /** Per-hop state map: hop ID -> HopState. */
  hops: z.record(z.string(), HopState),
  /** ISO-8601 timestamp when workflow execution started. */
  startedAt: z.string().datetime().optional(),
  /** ISO-8601 timestamp when workflow completed. */
  completedAt: z.string().datetime().optional(),
});

/** Top-level workflow field on task frontmatter. */
export const TaskWorkflow = z.object({
  /** Immutable DAG shape set at creation. */
  definition: WorkflowDefinition,
  /** Mutable execution progress. */
  state: WorkflowState,
});
```

**Confidence:** HIGH -- implements locked decisions. Map-based hop state enables `workflow.state.hops['implement'].status` access pattern per user specification.

### Pattern 4: Mutual Exclusivity Validation
**What:** TaskFrontmatter `.superRefine()` that rejects tasks with both gate and workflow fields.
**When to use:** Added to TaskFrontmatter schema to enforce the locked decision that gate-based and DAG-based fields are mutually exclusive.

```typescript
// In src/schemas/task.ts, after the z.object({...}) definition, before closing preprocess:

// Add to TaskFrontmatter z.object:
workflow: TaskWorkflow.optional().describe("Workflow DAG definition and execution state"),

// Then add superRefine for mutual exclusivity:
.superRefine((data, ctx) => {
  if (data.gate && data.workflow) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Task cannot have both 'gate' (linear workflow) and 'workflow' (DAG workflow) fields. Use one or the other.",
      path: ["workflow"],
    });
  }
});
```

**Confidence:** HIGH -- Zod `.superRefine()` verified available in installed version (3.25.76). Pattern confirmed working.

### Pattern 5: DAG Validation Function
**What:** Standalone `validateDAG()` function following the `validateWorkflow()` pattern: accepts a parsed WorkflowDefinition, returns `string[]` of errors.
**When to use:** Called at task creation time, in addition to Zod parse-time validation.

```typescript
/**
 * Validate a workflow DAG definition for structural correctness.
 *
 * Checks:
 * - Hop IDs are unique
 * - All dependsOn references point to existing hop IDs
 * - No cycles (via Kahn's algorithm / topological sort)
 * - All hops are reachable from at least one root hop
 * - At least one root hop exists (no dependsOn)
 * - Timeout format is valid (if specified)
 * - escalateTo is non-empty (if specified)
 *
 * @returns Array of validation errors (empty if valid)
 */
export function validateDAG(definition: WorkflowDefinition): string[] {
  const errors: string[] = [];
  // ... implementation
  return errors;
}
```

**Confidence:** HIGH -- mirrors established `validateWorkflow()` pattern exactly.

### Anti-Patterns to Avoid
- **Separate schema files for definition vs state:** Keep all DAG schemas in one file (`workflow-dag.ts`). The Gate/GateHistoryEntry pattern shows related schemas belong together. Splitting creates import cycles.
- **Using `.refine()` instead of `.superRefine()`:** `.refine()` returns a single boolean; `.superRefine()` allows multiple issues with specific paths and codes. DAG validation needs multiple error reporting.
- **Storing hop state as an array:** User decision locks this as a map keyed by hop ID. Array lookup is O(n) per access; map is O(1). The evaluator (Phase 11) will access hop state frequently.
- **Modifying `schemaVersion`:** User decision: stay at `schemaVersion: 1`. The `workflow` field is additive and optional. Do not bump.
- **Breaking the existing preprocess wrapper:** TaskFrontmatter uses `z.preprocess()` for `requiredRunbook`/`required_runbook` migration. The `.superRefine()` for mutual exclusivity must be chained after the inner `z.object()`, not on the outer preprocess.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cycle detection | Custom recursive DFS with visited set | Kahn's algorithm (topological sort) | Kahn's is simpler (~20 lines), produces topological order as a free side effect (useful for reachability), and handles all edge cases. DFS-based cycle detection needs separate "visiting" vs "visited" tracking. |
| Schema validation framework | Custom validation pipeline | Zod `.superRefine()` + standalone validate function | Zod already handles parse-time validation. The `validateDAG()` function follows existing `validateWorkflow()` pattern. No new framework needed. |
| YAML serialization | Custom frontmatter writer | Existing `serializeTask()` + `yaml` package | Task parser already handles YAML frontmatter round-trip. New fields are picked up automatically. |
| Atomic file writes | Custom fs.writeFile with rename | `write-file-atomic` package | Already a dependency, already used everywhere. Crash-safe by design. |

**Key insight:** Phase 10 is pure schema work. Every runtime concern (evaluation, scheduling, dispatch) is Phase 11+. The temptation is to "just add" evaluation logic since you're already in the schema file -- resist this. Keep schemas declarative.

## Common Pitfalls

### Pitfall 1: TaskFrontmatter Preprocess Wrapper Blocks superRefine
**What goes wrong:** TaskFrontmatter uses `z.preprocess()` which wraps the inner schema. Adding `.superRefine()` to the preprocess output does not work the same as adding it to the inner `z.object()`.
**Why it happens:** `z.preprocess()` returns a `ZodEffects` type, not a `ZodObject`. Chaining `.superRefine()` on `ZodEffects` is valid but the inner object's refinements run first.
**How to avoid:** Add the `.superRefine()` for gate/workflow mutual exclusivity to the inner `z.object()` chain (before the preprocess wraps it), not after. Alternatively, apply it as a refinement on the inner object. Test both `safeParse` and `parse` paths.
**Warning signs:** Tests pass for `z.object()` but fail when used through TaskFrontmatter (which wraps with preprocess).

### Pitfall 2: Hop ID Collision with Gate ID Semantics
**What goes wrong:** Existing code references `gate.current` as a string ID. If workflow hops reuse names like "implement", "review", code that switches on gate presence might misinterpret hop IDs.
**Why it happens:** The dual-mode evaluator (Phase 12) will need to distinguish gate IDs from hop IDs. If naming conventions collide, routing breaks.
**How to avoid:** The mutual exclusivity validation (gate XOR workflow) prevents a task from having both at runtime. This is sufficient -- no namespace collision can occur on a single task.
**Warning signs:** Tests that create tasks with both `gate` and `workflow` fields passing validation.

### Pitfall 3: Cycle Detection on Creation vs Parse
**What goes wrong:** Cycle detection in `.superRefine()` runs on every parse, including when loading existing tasks from disk. A corrupted task file with a cycle blocks all task loading.
**Why it happens:** Zod parse is used both for creation validation and deserialization of existing data.
**How to avoid:** Keep heavyweight graph validation (cycles, reachability) in the standalone `validateDAG()` function, NOT in the Zod schema's `.superRefine()`. The Zod schema validates structural correctness (types, required fields). The `validateDAG()` function validates semantic correctness (graph properties). Call `validateDAG()` explicitly at creation time, not on every parse.
**Warning signs:** Slow task loading, or inability to load task files for debugging/repair.

### Pitfall 4: Workflow State Initialization Gap
**What goes wrong:** A task is created with `workflow.definition` but `workflow.state` is not properly initialized (missing hop entries, wrong initial statuses).
**Why it happens:** The schema allows any valid state, but creation logic must derive initial state from the definition (all hops start as "pending", root hops as "ready").
**How to avoid:** Provide a `initializeWorkflowState(definition: WorkflowDefinition): WorkflowState` helper function that derives the initial state map from the definition. This is schema-layer utility, not evaluator logic. Include it in `workflow-dag.ts`.
**Warning signs:** Tasks created with empty `workflow.state.hops` map or hops missing from the state.

### Pitfall 5: YAML Serialization of Nested Objects
**What goes wrong:** The `yaml` package serializes deeply nested objects (workflow > definition > hops > condition) with excessive indentation, making frontmatter hard to read.
**Why it happens:** Default YAML serialization settings produce deep nesting for complex objects.
**How to avoid:** The existing `serializeTask()` uses `{ lineWidth: 120 }` which helps. Test serialization round-trip (parse -> serialize -> parse) to ensure no data loss. The `yaml` package handles Zod-parsed objects correctly since they are plain JS objects.
**Warning signs:** Frontmatter that is valid YAML but visually unreadable (10+ levels of indentation).

### Pitfall 6: Condition Schema Too Rigid for Phase 11
**What goes wrong:** The JSON DSL condition schema is defined too tightly in Phase 10, and Phase 11's evaluator needs operators or field access patterns not covered.
**Why it happens:** The condition DSL is used for hop activation (execute vs skip). The exact evaluation context (what fields are accessible, what operators are needed) depends on the evaluator design in Phase 11.
**How to avoid:** Define the condition schema as a discriminated union that is easily extensible (adding a new `op` variant is one line). Include common operators (eq, neq, gt, gte, lt, lte, in, has_tag, hop_status, and/or/not, true/false) but mark the schema as "Phase 11 evaluator consumes this -- additional operators may be added." Use `z.unknown()` for value types where the evaluation context determines meaning.
**Warning signs:** Phase 11 planner discovers the condition schema needs breaking changes.

## Code Examples

### Example 1: Complete Hop Schema with All Fields
```typescript
// Verified pattern based on existing Gate schema in gate.ts
const exampleHop = {
  id: "implement",
  role: "swe-backend",
  dependsOn: [],
  joinType: "all",
  autoAdvance: true,
  condition: { op: "has_tag", value: "backend" },
  description: "Initial implementation of the feature",
  canReject: false,
  timeout: "2h",
  escalateTo: "tech-lead",
};
```

### Example 2: WorkflowDefinition with Diamond DAG
```typescript
const diamondWorkflow = {
  name: "standard-sdlc",
  hops: [
    { id: "implement", role: "swe-backend" },
    { id: "test", role: "swe-qa", dependsOn: ["implement"], canReject: true },
    { id: "review", role: "swe-architect", dependsOn: ["implement"], canReject: true },
    { id: "deploy", role: "swe-ops", dependsOn: ["test", "review"], joinType: "all" },
  ],
};
```

### Example 3: Task Frontmatter with Workflow Field
```yaml
---
schemaVersion: 1
id: TASK-2026-03-02-001
project: my-project
title: Implement rate limiting
status: in-progress
priority: high
createdAt: "2026-03-02T10:00:00Z"
updatedAt: "2026-03-02T12:00:00Z"
lastTransitionAt: "2026-03-02T10:30:00Z"
createdBy: main
workflow:
  definition:
    name: standard-sdlc
    hops:
      - id: implement
        role: swe-backend
      - id: review
        role: swe-architect
        dependsOn: [implement]
        canReject: true
        autoAdvance: false
      - id: deploy
        role: swe-ops
        dependsOn: [review]
  state:
    status: running
    hops:
      implement:
        status: complete
        startedAt: "2026-03-02T10:30:00Z"
        completedAt: "2026-03-02T11:45:00Z"
        agent: swe-backend
      review:
        status: dispatched
        startedAt: "2026-03-02T11:45:00Z"
        agent: swe-architect
      deploy:
        status: pending
    startedAt: "2026-03-02T10:30:00Z"
---
```

### Example 4: Kahn's Algorithm for Cycle Detection
```typescript
// ~25 lines, zero dependencies
function detectCycles(hops: Hop[]): string[] {
  const errors: string[] = [];
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const hop of hops) {
    inDegree.set(hop.id, 0);
    adjacency.set(hop.id, []);
  }

  // Build adjacency and in-degree
  for (const hop of hops) {
    for (const dep of hop.dependsOn) {
      adjacency.get(dep)?.push(hop.id);
      inDegree.set(hop.id, (inDegree.get(hop.id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue = [...inDegree.entries()]
    .filter(([_, deg]) => deg === 0)
    .map(([id]) => id);
  let processed = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (processed !== hops.length) {
    const cycleHops = [...inDegree.entries()]
      .filter(([_, deg]) => deg > 0)
      .map(([id]) => id);
    errors.push(`Cycle detected involving hops: ${cycleHops.join(", ")}`);
  }

  return errors;
}
```

### Example 5: State Initialization Helper
```typescript
function initializeWorkflowState(definition: WorkflowDefinition): WorkflowState {
  const hops: Record<string, HopState> = {};

  for (const hop of definition.hops) {
    const isRoot = hop.dependsOn.length === 0;
    hops[hop.id] = {
      status: isRoot ? "ready" : "pending",
    };
  }

  return {
    status: "pending",
    hops,
  };
}
```

### Example 6: Mutual Exclusivity in TaskFrontmatter
```typescript
// Added to the inner z.object() in TaskFrontmatter, before preprocess wrapping
.superRefine((data, ctx) => {
  if (data.gate && data.workflow) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Task cannot have both 'gate' (linear workflow) and 'workflow' (DAG workflow) fields. " +
        "Gate-based and DAG-based workflows are mutually exclusive.",
      path: ["workflow"],
    });
  }
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Linear gate array (`gates: Gate[]`) | DAG with `dependsOn` edges (`hops: Hop[]`) | v1.2 (this phase) | Supports branching, parallelism, conditional paths |
| Gate state as `gate.current` string | Hop state as `workflow.state.hops` map | v1.2 (this phase) | O(1) lookup per hop, supports multiple active hops |
| Workflow defined at project level | Workflow defined per task (inline) | v1.2 (this phase) | Different tasks in same project can have different workflows |
| JavaScript `when` expressions | JSON DSL `condition` expressions | v1.2 (Phase 10 schema, Phase 13 enforcement) | Safe for agent-composed conditions; no eval/new Function |

**Deprecated/outdated:**
- Gate-based workflow fields (`gate`, `gateHistory`, `reviewContext`) remain supported but are the legacy path. Phase 15 adds migration tooling.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 3.0.0+ |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `npx vitest run src/schemas/__tests__/workflow-dag.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DAG-01 | Task parses with inline workflow DAG containing typed hops and edges | unit | `npx vitest run src/schemas/__tests__/workflow-dag.test.ts -t "WorkflowDefinition"` | Wave 0 |
| DAG-02 | Hop schema accepts all specified fields (role, condition, timeout, autoAdvance, etc.) | unit | `npx vitest run src/schemas/__tests__/workflow-dag.test.ts -t "Hop"` | Wave 0 |
| DAG-03 | Execution state persists and round-trips through YAML serialization | unit | `npx vitest run src/schemas/__tests__/workflow-dag.test.ts -t "WorkflowState"` | Wave 0 |
| DAG-04 | Invalid DAGs (cycles, unreachable, missing refs) rejected with errors | unit | `npx vitest run src/schemas/__tests__/workflow-dag.test.ts -t "validateDAG"` | Wave 0 |
| EXEC-08 | Hop lifecycle statuses match state machine (pending/ready/dispatched/complete/failed/skipped) | unit | `npx vitest run src/schemas/__tests__/workflow-dag.test.ts -t "HopStatus"` | Wave 0 |
| Compat | Tasks with gate fields parse without workflow (backward compat) | unit | `npx vitest run src/schemas/__tests__/task-gate-extensions.test.ts` | Existing |
| Exclusivity | Tasks with both gate and workflow rejected | unit | `npx vitest run src/schemas/__tests__/workflow-dag.test.ts -t "mutual exclusivity"` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/schemas/__tests__/workflow-dag.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before verification

### Wave 0 Gaps
- [ ] `src/schemas/__tests__/workflow-dag.test.ts` -- covers DAG-01, DAG-02, DAG-03, DAG-04, EXEC-08, mutual exclusivity
- [ ] No framework install needed (vitest already configured)
- [ ] No new fixtures needed (test data defined inline per established pattern in existing schema tests)

## Open Questions

1. **Condition DSL operator completeness**
   - What we know: Common operators defined (eq, neq, gt, gte, lt, lte, in, has_tag, hop_status, and/or/not, true/false). The evaluator (Phase 11) will consume this schema.
   - What's unclear: Whether Phase 11 will need additional operators (e.g., `contains`, `matches_regex`, `metadata_path` for nested access).
   - Recommendation: Define the core operators now. The discriminated union is trivially extensible -- adding a new `op` variant is one line with no breaking change. Phase 11 can extend as needed.

2. **Preprocess wrapper interaction with superRefine**
   - What we know: TaskFrontmatter uses `z.preprocess()` for `required_runbook` migration. `.superRefine()` must be on the inner `z.object()`.
   - What's unclear: Whether the preprocess wrapper will interfere with error path reporting from the superRefine.
   - Recommendation: Implement and test both valid and invalid cases. If error paths are wrong, move validation to the standalone `validateDAG()` function instead.

3. **State initialization ownership**
   - What we know: When a task is created with a workflow definition, the state must be initialized (root hops as "ready", others as "pending").
   - What's unclear: Whether initialization belongs in the schema layer (Phase 10) or the creation logic (Phase 12 scheduler integration).
   - Recommendation: Provide `initializeWorkflowState()` as a pure helper function in `workflow-dag.ts`. It is schema-adjacent (derives state from definition) and does not involve I/O. The creation logic (Phase 12+) calls it.

## Sources

### Primary (HIGH confidence)
- **Source code analysis** -- `src/schemas/task.ts`, `src/schemas/gate.ts`, `src/schemas/workflow.ts`, `src/schemas/index.ts`, `src/store/task-parser.ts`, `src/dispatch/gate-evaluator.ts`, `src/dispatch/gate-conditional.ts`, `src/store/task-mutations.ts` -- direct inspection of all integration points
- **Zod 3.25.76** -- Verified `.superRefine()`, `z.discriminatedUnion()`, `z.lazy()`, `z.record()` availability via runtime tests
- **Project research** -- `.planning/research/SUMMARY.md`, `ARCHITECTURE.md`, `FEATURES.md`, `PITFALLS.md` -- comprehensive pre-milestone research

### Secondary (MEDIUM confidence)
- **CONTEXT.md** -- User decisions locking implementation choices. Authoritative for this phase.
- **Kahn's algorithm** -- Standard graph algorithm for topological sort / cycle detection. Well-documented in computer science literature. No external library needed.

### Tertiary (LOW confidence)
- None. All findings verified against source code or established algorithms.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies, all patterns verified in existing codebase
- Architecture: HIGH -- direct extension of existing schema patterns (Gate -> Hop, WorkflowConfig -> WorkflowDefinition, GateState -> WorkflowState)
- Pitfalls: HIGH -- identified through source code analysis and prior project research
- Condition DSL: MEDIUM -- core operators defined, but completeness depends on Phase 11 evaluator needs (extensible by design)

**Research date:** 2026-03-02
**Valid until:** 2026-04-02 (stable domain -- schema design does not change rapidly)
