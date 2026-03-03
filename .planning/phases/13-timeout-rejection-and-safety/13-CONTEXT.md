# Phase 13: Timeout, Rejection, and Safety - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

DAG execution handles failure modes gracefully — per-hop timeout with escalation, rejection with downstream reset, and restricted JSON DSL validation for agent-authored conditions. No templates or artifact directories (Phase 14), no migration (Phase 15).

</domain>

<decisions>
## Implementation Decisions

### Hop timeout escalation
- Timed-out hop stays `dispatched` and gets re-assigned to the `escalateTo` role (mirrors gate timeout pattern — re-route, don't fail)
- Original agent's session is force-completed via existing `forceCompleteSession()` on GatewayAdapter
- Timeout checking happens during poll cycle only (alongside existing `checkGateTimeouts`) — not on session_end
- When `escalateTo` is not configured, emit alert event + log warning but don't change hop status (mirrors gate behavior)
- One-shot escalation only — if the escalateTo role also times out, emit alert but take no further action (no chain escalation)
- Hop timeout uses the `startedAt` timestamp on HopState to calculate elapsed time (set when hop is dispatched)

### Rejection cascade behavior
- Rejection triggered by reviewing agent's run result outcome (same pattern as gate rejections) — no separate CLI command
- `origin` strategy: full DAG reset — all hops return to pending/ready, workflow restarts from scratch (mirrors gate origin behavior)
- `predecessors` strategy: reset the rejected hop + its immediate `dependsOn` predecessors to pending — those re-execute, then rejected hop re-runs
- Reset hops have their results cleared (result, startedAt, completedAt, agent, correlationId all wiped) — clean slate for re-execution
- Completed parallel branches unrelated to the rejection path stay done (only reset hops that need re-execution)
- Rejection cascade is handled in the evaluator as a new event type (alongside complete/failed/skip)

### DSL safety validation
- DAG condition DSL is already safe: Zod-validated ConditionExpr with discriminated union + operator dispatch table (no eval/new Function)
- Add depth/complexity limit: max nesting depth (e.g., 5 levels of and/or/not) and max total conditions count — enforced in `validateDAG()`
- Validate hop references in conditions: `hop_status` operator and field paths referencing `hops.X...` must point to hop IDs that exist in the DAG
- No runtime evaluation timeout needed — the operator dispatch table evaluates synchronously with bounded recursion via depth limit
- Gate conditional evaluator (`gate-conditional.ts` with `new Function()`) is out of scope — SAFE-01 is about DAG conditions, gate system is being replaced in Phase 15

### Timeout/rejection events and observability
- DAG-specific event types added to EventType enum: `hop_timeout`, `hop_timeout_escalation`, `hop_rejected`, `hop_rejection_cascade`
- Hop timeouts and rejections generate alert actions (same pattern as gate timeouts) — notification rules pick them up via existing severity tiers
- Rejection events include the reviewing agent's rejection notes/reason in the event payload (mirrors gate rejection's `rejectionNotes`)
- Rejection count limit per hop with configurable maximum (default 3) — after N rejections, hop fails permanently to prevent infinite review-reject cycles

### Claude's Discretion
- Exact structure of the `checkHopTimeouts()` function (parallel to `checkGateTimeouts()`)
- How rejection event flows through the evaluator (new event type or outcome mapping)
- Internal implementation of depth/complexity counting for condition validation
- Metrics recording pattern for hop timeout/rejection events
- Test structure and fixture design for timeout/rejection scenarios

</decisions>

<specifics>
## Specific Ideas

- The hop timeout checker should structurally mirror `checkGateTimeouts()` in `src/dispatch/escalation.ts` — scan in-progress DAG tasks, check dispatched hops against their timeout, escalate or alert
- Rejection cascade in the evaluator should produce the same `HopTransition[]` change summary as skip cascading — enabling one atomic write to frontmatter per rejection event
- The `rejectionStrategy` enum (`origin` | `predecessors`) is already defined in the Hop schema — this phase implements the logic behind those values
- Force-complete of the timed-out agent's session should happen BEFORE re-dispatching to the escalateTo role — avoids two sessions for the same task

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/dispatch/escalation.ts`: `checkGateTimeouts()` + `escalateGateTimeout()` — structural pattern for hop timeout checking and escalation
- `src/dispatch/gate-evaluator.ts`: `handleRejectionOutcome()` — gate rejection pattern (origin strategy only) for reference
- `src/dispatch/dag-evaluator.ts`: `evaluateDAG()` + `cascadeSkips()` — rejection cascade can reuse skip cascade machinery
- `src/dispatch/dag-transition-handler.ts`: hop dispatch logic — force-complete + re-dispatch for timeout escalation
- `src/schemas/workflow-dag.ts`: `Hop` schema with `canReject`, `rejectionStrategy`, `timeout`, `escalateTo` placeholders already defined
- `src/schemas/workflow-dag.ts`: `ConditionExpr` Zod discriminated union — target for depth/complexity validation
- `src/schemas/workflow-dag.ts`: `validateDAG()` — add hop reference validation and condition depth checking here

### Established Patterns
- Pure function evaluation: evaluator returns structured result, caller applies side effects (continue for rejection)
- Poll-cycle timeout scanning: `checkGateTimeouts()` iterates in-progress tasks, checks elapsed time, returns alert actions
- Atomic state writes: `write-file-atomic` for crash-safe frontmatter persistence after rejection resets
- Event logging: `logger.log(type, source, { taskId, payload })` pattern for all scheduler events
- Alert actions: `{ type: 'alert', taskId, reason, agent }` for notification rule integration

### Integration Points
- `src/dispatch/scheduler.ts`: Add `checkHopTimeouts()` call alongside existing `checkGateTimeouts()` in poll cycle
- `src/dispatch/dag-evaluator.ts`: Add rejection event handling (new outcome type or new function) with cascade reset logic
- `src/dispatch/dag-transition-handler.ts`: Handle timeout escalation (force-complete + re-dispatch to escalateTo role)
- `src/schemas/workflow-dag.ts`: Add condition depth validation to `validateDAG()`, validate hop references in conditions
- `src/events/types.ts`: Add `hop_timeout`, `hop_timeout_escalation`, `hop_rejected`, `hop_rejection_cascade` event types

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 13-timeout-rejection-and-safety*
*Context gathered: 2026-03-03*
