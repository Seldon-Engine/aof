# Phase 10: DAG Schema Foundation - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Define all Zod schemas for workflow DAGs: hop definitions, dependency edges, execution state, and creation-time validation. The schema is additive to existing TaskFrontmatter (optional `workflow` field at schemaVersion 1). Existing gate-based tasks parse and function without modification. Evaluation logic, scheduler integration, and template registry are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Edge/dependency model
- Per-hop `dependsOn` array listing predecessor hop IDs (mirrors existing task `dependsOn` pattern)
- Hops with no `dependsOn` (or empty array) are root/start hops, eligible for parallel dispatch
- DAG completion is implicit — all hops reaching terminal state (complete/failed/skipped) = DAG done
- Per-hop `joinType: 'all' | 'any'` field for join hops with multiple predecessors; defaults to `all` (AND-join)

### Hop behavior modes
- Boolean `autoAdvance` per hop — true = scheduler advances immediately on completion; false = task moves to review, awaits approval
- Inline `condition` field on each hop with JSON DSL expression (evaluated to decide execute vs skip)
- Schema placeholders for rejection behavior: `canReject` boolean and `rejectionStrategy` field — actual logic implemented in Phase 13
- Optional `description` field for human/agent readability (zero cost if omitted)
- Optional `timeout` and `escalateTo` fields (schema defined here, timeout behavior in Phase 13)

### Execution state layout
- Top-level frontmatter field named `workflow` containing both definition and state
- Split into `workflow.definition` (immutable DAG shape set at creation) and `workflow.state` (mutable execution progress)
- Per-hop state stored as map of hop ID → state object (not array) for fast lookup
- Each hop state carries: `status` (pending/ready/dispatched/complete/failed/skipped), `startedAt`, `completedAt`, `agent`, `correlationId`, `result` (arbitrary output data)
- Persisted `workflow.state.status` field (pending/running/complete/failed) for quick DAG-level inspection without scanning all hops

### Schema versioning and compatibility
- Stay at `schemaVersion: 1` — `workflow` field is additive and optional
- Gate-based (`gate`/`gateHistory`) and DAG-based (`workflow`) fields are mutually exclusive on a task; validation rejects tasks with both
- WorkflowDAG definition schema designed to be reusable — same Zod schema works inline on task frontmatter AND as named template in project config (Phase 14 adds template registry)

### Claude's Discretion
- Exact Zod schema field ordering and nesting details
- Cycle detection and validation algorithm internals
- How the condition JSON DSL schema is structured in Zod (Phase 11 evaluator will consume it)
- Error message wording for validation failures
- Whether to use Zod refinements, transforms, or superRefine for cross-field validation

</decisions>

<specifics>
## Specific Ideas

- The `dependsOn` pattern should feel identical to existing task `dependsOn` — array of string IDs, same mental model
- Hop state map keyed by hop ID enables `workflow.state.hops['implement'].status` access pattern
- The `result` field on hop state enables hop-to-hop data passing via frontmatter alongside the filesystem artifact directories (Phase 14)
- Gate history entry pattern (`GateHistoryEntry`) is precedent for tracking per-stage execution metadata with timestamps

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/schemas/task.ts`: TaskFrontmatter with Zod preprocess, GateState, TaskRouting — pattern for optional workflow field
- `src/schemas/gate.ts`: Gate, GateHistoryEntry, ReviewContext, GateTransition — hop schema can mirror Gate's structure
- `src/schemas/workflow.ts`: WorkflowConfig, validateWorkflow() — validation pattern for cross-field checks
- `src/schemas/index.ts`: Barrel export pattern — new DAG schemas follow same export convention
- `src/store/task-parser.ts`: parseTaskFile/serializeTask — YAML frontmatter parse via `yaml` package, Zod validation

### Established Patterns
- Zod schemas define shapes, TypeScript types derived via `z.infer<typeof Schema>`
- Validation functions return `string[]` error arrays (see `validateWorkflow()`)
- Optional fields use `.optional()` with defaults via `.default()`
- Schema versioning via `schemaVersion: z.literal(1)` on frontmatter
- `write-file-atomic` for safe frontmatter persistence

### Integration Points
- `TaskFrontmatter` in `src/schemas/task.ts` — add optional `workflow` field
- `src/schemas/index.ts` — export new DAG schemas
- `src/store/task-parser.ts` — existing parser handles new fields automatically via Zod (no changes needed if schema is additive)
- `src/dispatch/gate-evaluator.ts` — dual-mode evaluator (Phase 12) will branch on `workflow` presence

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 10-dag-schema-foundation*
*Context gathered: 2026-03-02*
