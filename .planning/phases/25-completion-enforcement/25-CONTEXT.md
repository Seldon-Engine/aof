# Phase 25: Completion Enforcement - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Stop trusting agent exit codes. When an agent exits without calling `aof_task_complete`, the task is marked failed and retried — not silently auto-completed. Applies to both top-level tasks and DAG hop completions. SKILL.md and dispatch instructions updated to tell agents about the requirement.

</domain>

<decisions>
## Implementation Decisions

### Enforcement Rollout
- Block immediately — no warn-only mode, no gradual rollout
- Drop ENFC-02 (configurable warn/block) from scope — block is the only behavior
- Applies to both top-level task completions AND DAG hop completions (both code paths)
- No per-agent exemptions or escape hatches

### Failure Handling
- Agent exits without `aof_task_complete` → task transitions to failed → ready for retry
- Uses the existing dispatch failure counter (dispatchFailures) — 3 total failures of any kind = deadletter
- Enforcement reason stored on task metadata so the next agent picking up the task can see why the previous attempt failed
- Diagnostic message format: "Task failed: agent exited without calling aof_task_complete. Session had N tool calls in Xs."

### No-op Detection
- DEFERRED TO PHASE 26 — requires session transcript parsing which is trace infrastructure
- ENFC-03 moves from Phase 25 to Phase 26
- Phase 25 focuses purely on enforcement (no aof_task_complete = fail)
- When no-op IS detected (Phase 26): flag + warn on task metadata, but don't block completion. Task completes normally but carries a 'suspicious' flag.
- "Meaningful tool call" = any tool call at all (not just AOF-specific or write-only)

### Agent Messaging
- Both SKILL.md AND formatTaskInstruction() get completion instructions (belt and suspenders)
- SKILL.md: brief mention (~50 tokens) — "always call aof_task_complete"
- formatTaskInstruction(): detailed instruction at dispatch time with consequences
- SKILL.md also instructs agents to provide a brief summary of actions taken when calling aof_task_complete
- Enforcement error messages are diagnostic/technical (include tool call count, duration, trace reference)

### Claude's Discretion
- Exact token-efficient wording for SKILL.md addition
- Error message formatting details
- How to store enforcement reason in task metadata (which field in the metadata bag)

</decisions>

<specifics>
## Specific Ideas

- The enforcement should reference `aof trace <task-id>` in the diagnostic message, even though the trace CLI doesn't exist until Phase 27. This creates a forward reference that becomes useful once tracing ships.
- The original incident: architect agent ran for 13 seconds, zero tool calls, hallucinated completion. The enforcement message should include data that would have caught this (duration + tool call count).

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/dispatch/failure-tracker.ts`: `shouldTransitionToDeadletter()` — already handles 3-failure deadletter. Enforcement failures increment the same counter.
- `src/dispatch/assign-executor.ts:172-227`: The `onRunComplete` callback — exact code to modify. Lines 191-198 are the auto-complete fallback that must become a failure transition.
- `src/openclaw/openclaw-executor.ts`: `formatTaskInstruction()` — injection point for dispatch-time completion instructions.
- `src/events/logger.ts`: `logDispatch()` — existing event logging for dispatch events. Add new enforcement event types.

### Established Patterns
- Task metadata bag (`frontmatter.metadata`) for storing arbitrary key-value data — use for enforcement reason
- `dispatch.fallback` event already logged at line 215 — replace with `completion.enforcement` event
- DAG transition handler at `src/dispatch/dag-transition-handler.ts` — separate code path that also needs enforcement

### Integration Points
- `onRunComplete` callback is the primary hook — both success and failure paths
- `store.transition()` for state changes — currently does `review → done`, will become `failed → ready`
- SKILL.md at `skills/aof/SKILL.md` — token budget 1665/2150, 485 headroom
- Budget gate CI test must still pass after SKILL.md changes

</code_context>

<deferred>
## Deferred Ideas

- No-op detection (ENFC-03) — moved to Phase 26, requires transcript parsing
- Per-agent enforcement exemptions — not needed if all agents must call aof_task_complete
- Enforcement analytics/dashboards — v2 scope

</deferred>

---

*Phase: 25-completion-enforcement*
*Context gathered: 2026-03-07*
