# Phase 35: Bug Fixes - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix 4 known correctness bugs: task statistics miscounting, daemon uptime reporting, stale type definition, and scheduler race condition. No new features — purely corrective changes with regression tests.

</domain>

<decisions>
## Implementation Decisions

### BUG-03 Disposition
- Remove `blockers` field entirely from both `UpdatePatch` and `TransitionOpts` in task-mutations.ts
- Field is never read or written anywhere in the codebase — it's dead code, not misplaced code
- No backward compatibility concern since nothing uses it

### Claude's Discretion
- BUG-01: How to restructure buildTaskStats to include cancelled/deadletter (straightforward addition)
- BUG-02: Where exactly to place startTime inside startAofDaemon() (move from module scope to function scope)
- BUG-04: How to route scheduler-initiated transitions through task-lock-manager (existing task-lock.ts in protocol/)
- Whether to add regression tests per bug or batch them
- Commit granularity (per-bug or grouped)

</decisions>

<specifics>
## Specific Ideas

No specific requirements — bugs are well-defined by their success criteria in REQUIREMENTS.md and ROADMAP.md.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/protocol/task-lock.ts`: Existing task lock manager with tests — BUG-04 should integrate with this
- `src/dispatch/scheduler-helpers.ts`: Contains `buildTaskStats()` — BUG-01 target

### Established Patterns
- Task status directories: `STATUS_DIRS` in task-store.ts defines all valid statuses including cancelled/deadletter
- Daemon lifecycle: `startAofDaemon()` in daemon.ts, `startTime` currently at line 34 (module scope)

### Integration Points
- BUG-04: scheduler.ts and assign-executor.ts call `transitionTask`/`acquireLease` — these need lock manager wrapping
- BUG-01: `buildTaskStats()` result used by scheduler for dispatch decisions

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 35-bug-fixes*
*Context gathered: 2026-03-12*
