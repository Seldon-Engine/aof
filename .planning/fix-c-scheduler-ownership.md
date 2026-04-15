# Fix C — Scheduler-level dedupe of session-end handlers

**Status:** Planning. Not yet implemented.
**Depends on:** Fix A (per-task transition mutex, shipped in v1.14.8). Fix A
contains the blast radius by preventing the duplicate-file outcome, but two
scheduler handlers still fire for the same underlying event. Fix C addresses
the design smell at the scheduler layer.

## The incident in one paragraph

When an agent session dies mid-task (timeout, crash, or aborted stream), two
independent recovery paths fire in the same event-loop tick:

1. **`src/dispatch/assign-helpers.ts` — "completion enforcement"**
   Runs when `Promise.race` between the agent run and the timeoutMs timer
   resolves. If `outcome.success` is false (timeout, error, abort), transitions
   the task `in-progress → blocked` with reason `"Agent error: …"`.

2. **`src/dispatch/recovery-handlers.ts` — "stale heartbeat"**
   Scheduler poll detects the task's heartbeat TTL has expired. Reads
   `run_result.json`; if absent, transitions `in-progress → ready` with reason
   `"stale_heartbeat_reclaim"`.

Both are semantically correct *in isolation*; together, each sees a snapshot of
the task at `in-progress` and independently mutates it. The first one to finish
the rename leaves the task at its chosen destination; the second one's
`writeFileAtomic(oldPath)` resurrects a phantom file at the now-vacated old
path, and its subsequent `rename` moves that phantom to its own chosen
destination — the "duplicate task ID" corruption.

Fix A makes the second handler re-read fresh state and either no-op or throw
`Invalid transition`. That's a backstop. But the *design* question remains:
why do two handlers respond to one event?

## Root cause

Both handlers respond to the same underlying signal — "agent session ended
without calling `aof_task_complete`" — via two unrelated detection mechanisms:

- **assign-helpers** detects it because it owns the in-process run and sees
  the Promise resolve/reject.
- **recovery-handlers** detects it because the scheduler polls for tasks
  whose lease/heartbeat is stale.

When the adapter is in-process (i.e. `config.executor` is set — which it
always is for the OpenClaw gateway), these two detection mechanisms observe
the same failure at roughly the same moment: the agent run exits (assign-
helpers path fires) while the last heartbeat write stopped N seconds ago
(stale-heartbeat path fires on the next scheduler poll). In the production
incident the two fired 9 ms apart on the same poll tick.

**The design invariant that's missing**: for a given task run, exactly one
handler should own the post-completion state transition.

## Target architecture

### Principle: pre-condition check on every state-mutating scheduler action

Before any scheduler handler mutates a task, it should re-read the current
state and verify the pre-conditions it was dispatched against still hold. If
they don't (another handler beat it to the update), it should log and no-op.

This is a variant of compare-and-swap: the scheduler dispatches actions
based on a snapshot of the world; by the time an action runs, the world may
have moved. Today we trust that nothing else is mutating the task. Fix A
plus Fix C together make that trust mechanical.

### Concretely

Four scheduler action handlers mutate task state based on stale snapshots:

| Handler | File | Pre-condition today | Pre-condition after Fix C |
|---|---|---|---|
| `handleStaleHeartbeat` | `src/dispatch/recovery-handlers.ts` | Task exists | Task exists **and** `status === "in-progress"` **and** `lease.agent === action.agent` (if set) |
| `handleExpireLease` | `src/dispatch/lifecycle-handlers.ts` | Task exists | Task exists **and** lease is still expired at read time **and** status is `in-progress` or `blocked` (the two states the handler is written to cover) |
| `handleAssign` | `src/dispatch/assign-executor.ts` | Task in `ready` | Task still in `ready` at handler entry (not re-assigned by another path) |
| `handleSlaViolation` / `handlePromote` | `src/dispatch/lifecycle-handlers.ts` | Task exists | Task in the status the SLA was evaluated against |

All four should follow the same shape:

```ts
const task = await store.get(action.taskId);
if (!task) {
  log.warn({ taskId: action.taskId, op: "<handler>" }, "task gone, skipping");
  return { executed: false, failed: false };
}
const expected = <the status/lease/etc this handler was dispatched for>;
if (!matchesExpected(task, expected)) {
  log.info(
    { taskId: action.taskId, actualStatus: task.frontmatter.status, expected, op: "<handler>" },
    "pre-condition no longer holds — another handler already acted, skipping",
  );
  return { executed: false, failed: false };
}
// ... mutate ...
```

The `SchedulerAction` type gets a `preconditions` field populated at dispatch
time by `scheduler.ts` when it decides which actions to emit. Handlers read
from there instead of re-deriving. This keeps the dispatch/execution layers
honest.

### Why not rely on Fix A's mutex alone?

Fix A serializes the *mechanical* outcome so we never get a duplicate file.
But under the mutex, the second handler still executes — it just re-reads and
makes a secondary transition. In the incident that's fine (blocked → ready is
a valid follow-up). But when the two handlers disagree about the *meaning*
(one thinks the task failed, the other thinks the agent died cleanly and
should be retried), the second one wins for the wrong reason. Fix C stops
the second one from acting at all when its premise is stale.

### Narrower variant considered and rejected: short-circuit stale-heartbeat when executor is in-process

We could skip `handleStaleHeartbeat` entirely when `config.executor` is
defined, on the theory that assign-helpers will have already reacted to the
in-process timeout. This was tempting because it's ~5 LOC. Rejected because:

1. It only addresses the *specific* two-handler collision in this incident.
   The general class of stale-snapshot actions remains.
2. The stale-heartbeat path is still load-bearing for agents that crash
   silently without triggering the `Promise.race` timeout (e.g. an agent that
   hangs without exiting; timeoutMs not set; future out-of-process executors).
3. Gates the cleanup work behind an assumption about today's executor shape
   that will rot.

## Proposed phases

### Phase 1 — stale-heartbeat pre-condition (tightest scope, direct regression fix)

Modify `handleStaleHeartbeat` to re-read the task and skip if
`status !== "in-progress"` or if the lease's agent differs from the action's
agent (which would indicate re-dispatch happened). Adds `log.info` with the
actual-vs-expected delta for observability.

Adds a regression test that exercises the exact incident shape: a task is in
in-progress, another code path transitions it to blocked, the stale-heartbeat
action fires afterward, and we assert the action no-ops and emits the "skipped"
log record.

~20 LOC in handler + ~50 LOC test.

### Phase 2 — pre-condition envelope on SchedulerAction

Add `action.expected: { status?: TaskStatus; leaseAgent?: string; lastTransitionAtBefore?: string }` — the state the scheduler *thought* the task was in when it queued the action. Populate in `scheduler.ts`'s action-builder path. Have each handler early-return if the current task state doesn't match.

This is the real Fix C: it generalizes Phase 1 to all four handlers and to
any future scheduler action.

~100 LOC across scheduler + handlers + types, ~200 LOC of new tests (one per
handler + one per pre-condition dimension).

### Phase 3 (optional, defer) — action-level idempotency tokens

Every `SchedulerAction` gets a stable `actionId` derived from
`(type, taskId, lastTransitionAt)`. The handler checks a per-task ring buffer
of recently-completed action IDs and no-ops if this action has already run.
Guards against handler retries during scheduler crashes. Useful once we have
persistent action queues; premature today.

## Non-goals

- **Multi-process task store safety.** Fix A is intra-process. A filesystem
  advisory lock (using `open(O_CREAT|O_EXCL)` on a sidecar lock file) or a
  leases-via-rename primitive would be needed if AOF ever spawned a standalone
  daemon process in addition to the in-process plugin. Separate effort.
- **Event-log driven reconciliation.** We don't propose using
  `events.jsonl` to drive deduplication (e.g. "this task already saw a
  transition, skip"). It would work but ties scheduling to the event log's
  availability and durability — too much implicit coupling.

## Success criteria

1. The reproduction in
   `src/store/__tests__/task-store-concurrent-transition.test.ts`
   continues to pass (no file duplication) — Fix A invariant intact.
2. A new test that fires a stale-heartbeat action against a task that has
   been transitioned to `blocked` since the action was queued asserts:
   `actionsFailed === 0`, `actionsExecuted === 0` with a `skipped` log
   record describing the mismatch.
3. No unresolved `scheduler_action_failed` events of type
   `stale_heartbeat` in any integration test's events.jsonl.

## Milestone references

- Phase 1 should land as v1.14.9 (or sooner, as a direct patch).
- Phase 2 is a minor: v1.15.0. Changes the `SchedulerAction` shape (adds
  optional fields — backwards-compatible for consumers that accept the type,
  forward-incompatible for producers that need to populate it). Scheduler and
  handlers ship together.
