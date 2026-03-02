# Phase 1: Foundation Hardening - Context

**Gathered:** 2026-02-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Make the scheduler and task lifecycle restart-safe and failure-aware. The scheduler poll loop gets timeout guards, the daemon shuts down cleanly by draining in-flight transitions, crashed instances reclaim orphaned tasks on startup, and failures are classified as transient (retry) or permanent (dead-letter). This phase covers scheduler-level transitions only — long-running dispatched agent sessions are tracked in Phase 3/4.

</domain>

<decisions>
## Implementation Decisions

### Timeout & abort strategy
- Default poll timeout: 30 seconds (configurable)
- On timeout: cancel the hanging promise, log a warning, start next poll cycle
- Any half-finished transitions are rolled back or retried next cycle
- Per-task transition timeouts in addition to the global poll timeout (e.g. 10s per task so one slow task doesn't burn the whole poll budget)
- Timeout events emitted through the existing event system (e.g. `poll.timeout`) plus warning log — health endpoint and future alerting can react

### Drain semantics
- Drain timeout: 10 seconds after receiving stop signal
- On stop signal: stop the poll loop immediately, no new polls, only finish transitions already started
- If tasks still in-flight when drain timeout expires: force exit, leave tasks in current state — the startup reconciler (FOUND-03) reclaims them on next boot
- Countdown progress logs during drain (e.g. "3 tasks still draining...", "1 task remaining...")

### Reclaim safety
- Immediate reclaim on startup — no cooldown delay
- Build on existing lease/ownership pattern already in the codebase
- Orphaned tasks reset to their previous state (e.g. if mid-transition from `ready` to `dispatched`, reset to `ready`). Next poll cycle picks them up naturally.
- Note: "orphaned" in Phase 1 means interrupted state transitions, not long-running dispatched work
- Startup reconciler logs each reclaimed task individually (ID, previous state, what happened) plus a summary line

### Failure taxonomy
- Unknown/unexpected errors default to transient (retry with backoff)
- Rate limit errors: transient (retry with backoff)
- Missing agent errors: permanent (dead-letter immediately)
- Max retry attempts: 3 (original + 2 retries) before dead-lettering
- Backoff strategy: exponential with jitter (prevents thundering herd)
- Dead-letter events emitted (`task.deadlettered`) with task ID, error history, and attempt count
- Full failure chain logged on dead-letter

### Claude's Discretion
- Exact per-task timeout value (suggested ~10s but Claude can adjust based on codebase)
- Backoff base interval and jitter range
- How existing lease pattern is extended for the timeout guard
- Internal data structures for retry tracking

</decisions>

<specifics>
## Specific Ideas

- Dispatched research tasks can run 10+ minutes — Phase 1 orphan reclaim is explicitly scoped to scheduler transitions (seconds), not dispatched work
- Existing lease/ownership pattern in the codebase should be the foundation for orphan detection

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation-hardening*
*Context gathered: 2026-02-25*
