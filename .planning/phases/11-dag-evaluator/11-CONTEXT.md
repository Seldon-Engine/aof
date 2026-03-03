# Phase 11: DAG Evaluator - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

A pure-function evaluator that takes a DAG definition, current execution state, and a hop completion/failure event, then returns the new workflow state plus a change summary (hop transitions, newly ready hops, DAG completion). No scheduler integration (Phase 12), no timeout/rejection handling (Phase 13), no template resolution (Phase 14).

</domain>

<decisions>
## Implementation Decisions

### Evaluator API shape
- Single `evaluateDAG()` function handles all hop events (completion, failure, skip) — dispatches on event type internally
- Input: `WorkflowDefinition` + `WorkflowState` + hop event object (hopId, outcome, result data) — pure function with no task dependency
- Returns both a new `WorkflowState` (immutable replacement) AND a change summary listing hop transitions, newly ready hops, and optional DAG status change
- `initializeWorkflowState()` from Phase 10 is sufficient for initial readiness — evaluator only runs on hop events, not at DAG creation

### Condition evaluation context
- Context object contains: all completed hop results (keyed by hop ID) + basic task metadata (status, tags, priority, routing)
- Field paths use dot-path resolution (e.g., `hops.review.result.approved`, `task.priority`) — simple lodash-style get()
- Missing fields resolve to `undefined` and are treated as falsy — comparisons against undefined return false (except `neq` which returns true)
- `hop_status` operator reads directly from the live `WorkflowState.hops` map — it's a special operator, not a field lookup through context

### Skip cascading logic
- A downstream hop auto-skips only if ALL its predecessors are in terminal non-success state (skipped or failed) — if any predecessor completed, the hop can still proceed
- Skip cascading is fully recursive in a single evaluator call — if A skips → B skips → C skips, all transitions appear in one change summary
- OR-join hops (`joinType: 'any'`) become ready as soon as ANY predecessor completes (not just any terminal state — only `complete` triggers readiness)
- AND-join hops with some predecessors completed and some skipped (but none pending/dispatched) become ready — skipped predecessors count as "satisfied" for AND-join purposes

### DAG completion semantics
- DAG status = `complete` when every hop is either `complete` or `skipped` — no pending, ready, or dispatched hops remain
- Parallel branches continue executing when a hop fails — a failed hop only blocks its own downstream dependents via skip cascade
- DAG status = `failed` when all hops are terminal and at least one is `failed` — distinguishes from `complete` (all success/skipped)
- Evaluator result includes an optional `taskStatus` field (e.g., `done`, `failed`) — scheduler applies it, keeping completion logic centralized in the evaluator

### Claude's Discretion
- Exact TypeScript interface naming and field layout for input/result types
- Internal implementation of dot-path resolution (lodash-style or custom)
- Condition evaluator function structure (single function or per-operator dispatch table)
- Error handling for malformed conditions (shouldn't happen if Zod-validated, but defensive coding approach)
- Test structure and fixture design

</decisions>

<specifics>
## Specific Ideas

- The evaluator should mirror the gate evaluator's pattern: `evaluateGateTransition(input): GateEvaluationResult` → `evaluateDAG(input): DAGEvaluationResult`
- Change summary in the result enables the scheduler to log exactly which hops transitioned without diffing states
- The `taskStatus` suggestion field in the result keeps the task lifecycle logic co-located with DAG evaluation, avoiding duplication in the scheduler
- Recursive skip cascade in a single call means one atomic write to frontmatter per hop event — no intermediate states on disk

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/schemas/workflow-dag.ts`: WorkflowDefinition, WorkflowState, HopState, ConditionExpr schemas — evaluator consumes these directly
- `src/schemas/workflow-dag.ts`: `initializeWorkflowState()` — handles initial hop readiness, evaluator handles subsequent transitions
- `src/schemas/workflow-dag.ts`: `validateDAG()` — validation is done at creation time; evaluator can assume valid DAGs
- `src/dispatch/gate-evaluator.ts`: `evaluateGateTransition()` — structural pattern for pure-function evaluation with input/result interfaces

### Established Patterns
- Pure function evaluation: gate evaluator takes structured input, returns structured result with updates and skipped items
- No side effects in evaluation: caller (scheduler) applies the returned state changes
- Error arrays for validation (`validateDAG()` returns `string[]`) — evaluator can use similar pattern for condition evaluation errors
- Zod schemas as source of truth — evaluator types derived from existing schemas

### Integration Points
- `src/dispatch/gate-evaluator.ts` — Phase 12 will add a dual-mode evaluator that routes to gate evaluator or DAG evaluator based on task frontmatter
- `src/schemas/index.ts` — barrel export new evaluator types alongside existing DAG schemas
- `src/store/task-parser.ts` — evaluator result's new WorkflowState is written back via existing atomic write infrastructure

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 11-dag-evaluator*
*Context gathered: 2026-03-02*
