# Phase 12: Scheduler Integration - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

The scheduler dispatches DAG hops as independent OpenClaw sessions and advances the DAG on each completion. Gate-based tasks continue working unchanged. No timeout/rejection handling (Phase 13), no templates or artifact directories (Phase 14), no migration (Phase 15).

</domain>

<decisions>
## Implementation Decisions

### Hop dispatch mechanics
- Agent receives hop-scoped context only: hop ID, hop description, role, upstream hop results from completed predecessors — no full DAG visibility
- Task stays in-progress for the entire DAG execution; hop-level state is tracked in `workflow.state`, not task status
- Hop's `role` field maps to org chart routing via the same resolution logic used for task routing (role → agent)
- Hop status set to `dispatched` only after `spawnSession()` succeeds — if spawn fails, hop stays `ready` for retry on next poll

### Completion-triggered advancement
- DAG evaluation happens in `handleSessionEnd()`, alongside existing gate logic — immediate advancement, poll cycle as fallback
- Run result outcome maps to hop event: agent reports `done` → hop event `{outcome: 'complete'}`, `blocked`/error → `{outcome: 'failed'}`; run result notes/data become the hop's `result` field
- When a hop has `autoAdvance: false`, task moves to `review` status; existing review/approval flow resumes DAG evaluation and dispatches next hops
- Hop state changes written via atomic write to task frontmatter (read task, update `workflow.state` with evaluator result, `write-file-atomic`) — one write per hop event

### Dual-mode gate/DAG routing
- Branch point is in both `handleSessionEnd` and poll cycle: check `task.frontmatter.workflow` vs `task.frontmatter.gate` to route to correct evaluator
- Existing gate code (evaluation, timeout checking, gate-related scheduler actions) remains completely untouched — DAG code sits alongside, zero changes to gate path
- DAG tasks use standard task lifecycle (backlog → ready → in-progress); once dispatched (in-progress), scheduler looks at `workflow.state` for ready hops and dispatches the first root hop

### Parallel hop serialization
- When `evaluateDAG` returns multiple `readyHops`, dispatch the first one immediately; remaining hops stay in `ready` status for next poll cycle or session_end handler
- Cross-task priority: DAG hop dispatch uses the same priority ordering as existing `buildDispatchActions` — no special treatment for DAG tasks
- Active hop tracking: hop status map in `workflow.state` is the source of truth — hop with status `dispatched` is the active one; scheduler checks for no existing `dispatched` hop before dispatching another; no redundant `activeHopId` field

### Claude's Discretion
- Internal structure of hop context injection (how to build TaskContext from hop data)
- Exact placement of DAG evaluation within handleSessionEnd flow
- How to detect "this task is a DAG task" during the poll cycle dispatch path
- Event logging payloads for DAG hop dispatch and advancement
- Error handling for edge cases (e.g., session ends but no matching dispatched hop)

</decisions>

<specifics>
## Specific Ideas

- The completion flow should mirror the gate pattern: `handleSessionEnd → read run result → evaluate → dispatch next` — just with `evaluateDAG()` instead of `evaluateGateTransition()`
- The "one dispatched hop at a time" invariant is enforced by checking the hop status map before dispatch — same simplicity as the OpenClaw one-session constraint
- For review hops (autoAdvance: false), the existing review → approval → resume flow means no new approval mechanism needed — the scheduler just re-evaluates the DAG when the task returns from review
- Ready hops that don't get dispatched immediately (parallel branches) naturally get picked up on the next session_end or poll cycle — no queue infrastructure needed

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/dispatch/dag-evaluator.ts`: `evaluateDAG()` pure function — returns new state, hop transitions, ready hops, optional task status
- `src/dispatch/gate-evaluator.ts`: `evaluateGateTransition()` — structural pattern for the gate code path (stays untouched)
- `src/dispatch/executor.ts`: `GatewayAdapter` interface with `spawnSession()` — used for hop dispatch
- `src/dispatch/task-dispatcher.ts`: `buildDispatchActions()` — existing dispatch logic DAG tasks integrate with
- `src/dispatch/action-executor.ts`: `executeActions()` — action execution with concurrency management
- `src/protocol/router.ts`: `ProtocolRouter.handleSessionEnd()` — completion flow where DAG evaluation hooks in
- `src/protocol/router-helpers.ts`: `applyCompletionOutcome()` — maps run results to task transitions (DAG equivalent needed)
- `src/store/task-parser.ts`: `parseTaskFile()`/`serializeTask()` — atomic frontmatter read/write for hop state persistence

### Established Patterns
- Pure function evaluation: evaluator returns structured result, caller applies side effects
- Run result outcome mapping: `done` → advance, `blocked` → block, error → fail
- `write-file-atomic` for crash-safe frontmatter persistence
- Priority-based dispatch ordering in `buildDispatchActions`
- Session hooks (`session_end`, `agent_end`) trigger immediate processing + poll as fallback

### Integration Points
- `src/protocol/router.ts`: Add DAG branch to `handleSessionEnd()` — if task has `workflow`, evaluate DAG and dispatch next hop
- `src/dispatch/scheduler.ts`: Poll cycle needs DAG-aware dispatch — check in-progress DAG tasks for ready hops
- `src/dispatch/task-dispatcher.ts`: May need hop-aware dispatch actions alongside regular task dispatch
- `src/schemas/index.ts`: Export any new DAG-related types from scheduler integration
- `src/service/aof-service.ts`: `handleSessionEnd` delegates to ProtocolRouter — chain stays the same

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 12-scheduler-integration*
*Context gathered: 2026-03-03*
