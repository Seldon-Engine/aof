# AOF Bug Reports

> Archived (fixed) bugs moved to `bug-reports-archive.md`.

---

## BUG-005: AOF tasks can reconcile to `deadletter` even when the requested work completed successfully outside the task lifecycle

**Date/Time:** 2026-04-23 16:42 EDT
**Severity:** P2
**Status:** new
**Environment:** AOF local (`~/Projects/AOF`), OpenClaw orchestration using both AOF tasks and direct subagent fallback

### Short Description
Two real AOF tasks for the Opreto component-library rollout (`TASK-2026-04-23-004`, `TASK-2026-04-23-005`) never visibly progressed through normal task states. The work was completed successfully via direct subagent runs after AOF failed to pick them up. Later, AOF reconciled both tasks to `deadletter` rather than preserving actionable failure context or allowing an explicit coordinator closeout path.

### Observed Symptoms
Original tasks:
- `TASK-2026-04-23-004` — Implement Opreto component library + showcase + skill integration for report assembly (`swe-frontend`)
- `TASK-2026-04-23-005` — Define Opreto report/web component library for agent-authored rich content (`swe-ux`)

Observed timeline:
1. Both tasks were dispatched and remained in `ready` for >1 hour with no visible pickup.
2. Coordinator manually added check-in updates asking the assigned agents to acknowledge/start/block.
3. Because no progress occurred, the same work was executed through direct `sessions_spawn` subagent runs instead.
4. The subagent runs completed successfully and the requested files/specs/components/showcase updates landed.
5. Later, `aof_status_report` showed both original AOF tasks as `deadletter`, not `done`, `blocked`, `cancelled`, or `superseded`.

### Expected Behavior
When work associated with a task is superseded, manually rerouted, or otherwise completed outside the original scheduler path, AOF should support a clean terminal state such as:
- `cancelled` with explicit reason,
- `blocked` with explicit reason,
- `superseded`, or
- explicit coordinator completion override with audit trail.

It should not silently strand such tasks into `deadletter` without an obvious lifecycle explanation.

### Actual Behavior
The tasks never progressed through visible execution states, but eventually surfaced as `deadletter` while the requested work had in fact been completed through fallback orchestration.

### Impact
Medium. This creates misleading operational history:
- dashboards imply failure/abandonment,
- coordinators lose traceability between requested work and delivered work,
- periodic status checks can report confusing state that no longer matches reality.

This is especially damaging during shakeout periods when coordinators are intentionally falling back to direct execution to keep momentum.

### Reproduction (approximate)
1. Dispatch tasks to assigned agents.
2. Observe no pickup from `ready` for an extended period.
3. Complete the same work through a direct subagent path outside AOF.
4. Re-check AOF status later.
5. Observe tasks reconciled to `deadletter` rather than an explicit superseded/cancelled outcome.

### Hypothesis
AOF likely has a stale-task sweeper / reconciler that moves tasks with certain orphaned conditions into `deadletter`, but it does not distinguish between:
- truly abandoned/orphaned tasks,
- tasks awaiting manual intervention,
- tasks intentionally superseded by fallback execution.

There may be no first-class "superseded" or "externally completed" concept in the lifecycle, forcing the scheduler to treat these as dead mail.

### Proposed Fix
1. Add an explicit terminal outcome such as `superseded` (or `completed_elsewhere`).
2. Allow coordinators to mark tasks with that outcome and preserve a reason/body note linking the replacement execution path.
3. Ensure stale-task reconciliation prefers a diagnosable blocked/cancelled/superseded state over `deadletter` when the task was previously valid and simply not picked up.
4. Improve observability so the transition into `deadletter` includes the reason and trigger in task history / status reports.

### Workaround
If fallback execution is needed today, coordinators should explicitly annotate the task body before rerouting and, where possible, manually cancel/block it rather than letting it age out. But this is only partial because the existing lifecycle still appears to reconcile some such tasks into `deadletter` anyway.

---
