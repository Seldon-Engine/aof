# Phase 25: Completion Enforcement - Research

**Researched:** 2026-03-07
**Domain:** Dispatch lifecycle, agent completion detection, task state transitions
**Confidence:** HIGH

## Summary

Phase 25 converts the existing auto-completion fallback (where agents that exit without calling `aof_task_complete` get silently auto-completed) into a hard failure. The codebase is well-structured for this change: the `onRunComplete` callback in `assign-executor.ts` (lines 172-227) is the single code path for top-level task fallback handling, and the DAG path in `dag-transition-handler.ts` already treats missing run results as no-ops (hop stays dispatched, eventually times out). The failure-tracker module (`trackDispatchFailure` + `shouldTransitionToDeadletter`) already implements 3-strike deadlettering.

There is no `failed` status in the TaskStatus enum. The enforcement path uses `in-progress -> blocked` (with enforcement metadata), then the existing retry mechanism transitions `blocked -> ready`. After 3 total dispatch failures, `transitionToDeadletter` moves the task to `deadletter`. This is the exact same path used for spawn failures today.

**Primary recommendation:** Modify the `onRunComplete` callback's success branch (lines 191-198 of `assign-executor.ts`) to call `trackDispatchFailure` + transition to `blocked` instead of auto-completing via `review -> done`. Add `completion.enforcement` event type to the event schema. Update `formatTaskInstruction()` and SKILL.md with completion requirements.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Block immediately -- no warn-only mode, no gradual rollout
- Drop ENFC-02 (configurable warn/block) from scope -- block is the only behavior
- Applies to both top-level task completions AND DAG hop completions (both code paths)
- No per-agent exemptions or escape hatches
- Agent exits without `aof_task_complete` -> task transitions to failed -> ready for retry
- Uses the existing dispatch failure counter (dispatchFailures) -- 3 total failures of any kind = deadletter
- Enforcement reason stored on task metadata so the next agent can see why previous attempt failed
- Diagnostic message format: "Task failed: agent exited without calling aof_task_complete. Session had N tool calls in Xs."
- No-op detection (ENFC-03) DEFERRED TO PHASE 26 -- requires session transcript parsing
- Both SKILL.md AND formatTaskInstruction() get completion instructions (belt and suspenders)
- SKILL.md: brief mention (~50 tokens) -- "always call aof_task_complete"
- formatTaskInstruction(): detailed instruction at dispatch time with consequences
- SKILL.md also instructs agents to provide a brief summary of actions taken when calling aof_task_complete
- Enforcement error messages are diagnostic/technical (include tool call count, duration, trace reference)
- Enforcement should reference `aof trace <task-id>` in the diagnostic message (forward reference)

### Claude's Discretion
- Exact token-efficient wording for SKILL.md addition
- Error message formatting details
- How to store enforcement reason in task metadata (which field in the metadata bag)

### Deferred Ideas (OUT OF SCOPE)
- No-op detection (ENFC-03) -- moved to Phase 26, requires transcript parsing
- Per-agent enforcement exemptions -- not needed if all agents must call aof_task_complete
- Enforcement analytics/dashboards -- v2 scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ENFC-01 | Task is marked failed (not done) when agent exits without calling `aof_task_complete` | Modify `onRunComplete` success branch in `assign-executor.ts:191-198`. Use `trackDispatchFailure` + `store.transition(taskId, "blocked")`. DAG path: add `onRunComplete` to `dispatchDAGHop` or add enforcement check in `handleSessionEnd`. |
| ENFC-02 | ~~Configurable warn/block mode~~ | **DROPPED per user decision.** Block-only, no configuration needed. |
| ENFC-03 | ~~No-op detection for zero tool calls~~ | **DEFERRED to Phase 26** per user decision. |
| ENFC-04 | Enforcement events emitted to JSONL event log | Add `completion.enforcement` to EventType enum in `schemas/event.ts`. Replace `dispatch.fallback` logging with new event type. Include `durationMs`, `sessionId`, `correlationId`, `toolCallCount` in payload. |
| GUID-01 | SKILL.md updated to instruct agents about `aof_task_complete` requirement | Add ~50 token section to `skills/aof/SKILL.md`. Budget: 1665/2150 used, 485 headroom. Budget gate test at `src/context/__tests__/context-budget-gate.test.ts` must still pass. |
| GUID-02 | `formatTaskInstruction()` includes completion expectations at dispatch time | Modify `openclaw-executor.ts:301-317`. Already has basic completion instruction; enhance with consequences and diagnostic context. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| write-file-atomic | (existing) | Atomic task file writes | Already used throughout dispatch |
| zod | (existing) | Schema validation for event types | Already validates EventType enum |
| vitest | (existing) | Test framework | Project standard |

### Supporting
No new dependencies required. All changes use existing libraries.

## Architecture Patterns

### Modification Points (Exact Locations)

```
src/
├── dispatch/
│   ├── assign-executor.ts       # Lines 172-227: onRunComplete callback (PRIMARY)
│   ├── failure-tracker.ts       # trackDispatchFailure() — reuse as-is
│   └── dag-transition-handler.ts # dispatchDAGHop() — needs onRunComplete or enforcement in handleSessionEnd
├── schemas/
│   └── event.ts                 # Add "completion.enforcement" to EventType enum
├── events/
│   └── logger.ts                # No changes needed — generic log() method handles new event type
├── openclaw/
│   └── openclaw-executor.ts     # Lines 301-317: formatTaskInstruction() — enhance
├── protocol/
│   └── router.ts                # Lines 286-330: handleSessionEnd() — DAG enforcement check
└── skills/aof/
    └── SKILL.md                 # Add completion requirement (~50 tokens)
```

### Pattern 1: Top-Level Task Enforcement (assign-executor.ts)

**What:** Replace auto-completion with failure transition in the `onRunComplete` callback.

**Current behavior (lines 191-198):**
```typescript
if (outcome.success) {
  // Agent succeeded but didn't transition — move through review → done
  await store.transition(action.taskId, "review", {
    reason: "dispatch.fallback: agent completed without calling aof_task_complete",
  });
  await store.transition(action.taskId, "done", {
    reason: "dispatch.fallback: auto-completed after successful agent run",
  });
}
```

**New behavior:**
```typescript
// Agent exited without calling aof_task_complete — enforcement failure
const durationSec = (outcome.durationMs / 1000).toFixed(1);
const enforcementReason =
  `Task failed: agent exited without calling aof_task_complete. ` +
  `Session had N tool calls in ${durationSec}s. ` +
  `Run \`aof trace ${action.taskId}\` for session details.`;

// Store enforcement reason in task metadata
const taskForMeta = await store.get(action.taskId);
if (taskForMeta) {
  taskForMeta.frontmatter.metadata = {
    ...taskForMeta.frontmatter.metadata,
    enforcementReason,
    enforcementAt: new Date().toISOString(),
  };
  // write atomically...
}

// Track as dispatch failure (3 strikes = deadletter)
await trackDispatchFailure(store, action.taskId, enforcementReason);

// Check deadletter threshold
const updatedTask = await store.get(action.taskId);
if (updatedTask && shouldTransitionToDeadletter(updatedTask)) {
  await transitionToDeadletter(store, logger, action.taskId, enforcementReason);
} else {
  await store.transition(action.taskId, "blocked", {
    reason: enforcementReason,
  });
}
```

### Pattern 2: DAG Hop Enforcement

**What:** The DAG path (`dispatchDAGHop`) currently calls `executor.spawnSession` WITHOUT `onRunComplete`. DAG completion is handled later in `handleSessionEnd()` in the protocol router (lines 286-330), which reads `run_result.json`.

**Key insight:** DAG hops complete via `aof_task_complete` tool call, which writes a `run_result.json` and routes through the protocol router. If the agent exits without calling the tool, NO run result exists, and the hop stays in `dispatched` status indefinitely (until the DAG hop timeout fires, if configured).

**Options for DAG enforcement:**
1. **Add `onRunComplete` to `dispatchDAGHop`** — mirrors the top-level pattern. When agent finishes without `aof_task_complete`, the callback fires and can fail the hop.
2. **Add enforcement check in `handleSessionEnd`** — detect dispatched hops where the agent process has exited but no run result was written.

**Recommendation:** Option 1 is cleaner. Pass `onRunComplete` through `dispatchDAGHop` so the enforcement happens at the same point (agent exit) for both code paths.

### Pattern 3: Metadata Storage for Enforcement Reason

**What:** Store enforcement context in `frontmatter.metadata` so the next retry agent can see why the previous attempt failed.

**Recommended metadata fields:**
```typescript
{
  enforcementReason: string;    // Human-readable diagnostic
  enforcementAt: string;        // ISO timestamp
  // Existing fields updated by trackDispatchFailure:
  dispatchFailures: number;
  lastDispatchFailureReason: string;
  lastDispatchFailureAt: number;
}
```

### Anti-Patterns to Avoid
- **Adding a new `failed` status:** The `blocked` status already serves this purpose with automatic retry. Adding a new status would require updating all state machine consumers.
- **Checking task status in a separate poll loop:** The `onRunComplete` callback fires synchronously after agent exit -- use it, don't poll.
- **Storing enforcement data outside the task file:** Metadata bag is the established pattern. Don't create a separate enforcement log.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Failure counting + deadletter | Custom counter | `trackDispatchFailure()` + `shouldTransitionToDeadletter()` | Already handles 3-strike logic, metadata persistence, and deadletter transitions |
| Event emission | Custom file appends | `EventLogger.log()` with new event type | Handles date-based file rotation, symlinks, event IDs |
| Atomic task writes | `fs.writeFile()` | `write-file-atomic` | Prevents partial writes on crash |
| State transitions | Direct status field mutation | `store.transition()` | Validates transitions against the state machine |

## Common Pitfalls

### Pitfall 1: Race Between aof_task_complete and onRunComplete
**What goes wrong:** Agent calls `aof_task_complete` (transitioning task to `review`/`done`) but the `onRunComplete` callback fires AFTER. The callback checks `currentTask.frontmatter.status !== "in-progress"` -- if the tool call already transitioned the task, the callback correctly exits early (line 181).
**Why it matters:** This existing guard is critical. The enforcement code must remain INSIDE the `if (currentTask.frontmatter.status !== "in-progress") return;` check that already exists on line 181.
**How to avoid:** Don't restructure the guard -- the enforcement code replaces only the body of the success branch (lines 191-198), not the guard.

### Pitfall 2: DAG Path Has No onRunComplete
**What goes wrong:** Implementing enforcement only in `assign-executor.ts` and missing the DAG path. DAG hops dispatched via `dispatchDAGHop` don't have an `onRunComplete` callback.
**Why it happens:** Two separate code paths for dispatch (top-level vs DAG).
**How to avoid:** Must modify `dispatchDAGHop` to accept and wire an `onRunComplete` callback, similar to `executeAssignAction`.
**Warning signs:** DAG workflow tasks auto-completing without calling `aof_task_complete`.

### Pitfall 3: SKILL.md Budget Gate Failure
**What goes wrong:** Adding too many tokens to SKILL.md causes the budget gate CI test to fail.
**Why it happens:** `context-budget-gate.test.ts` asserts SKILL.md tokens stay under 50% of the pre-v1.4 baseline (< 1706 tokens). Current usage is 1665 tokens, leaving only 485 tokens of headroom.
**How to avoid:** Keep the SKILL.md addition under ~40 tokens. Use terse, direct language. Verify by running `npx vitest run src/context/__tests__/context-budget-gate.test.ts`.
**Warning signs:** CI failure in `context budget gate` test suite.

### Pitfall 4: Incorrect State Transition Path
**What goes wrong:** Trying to transition from `in-progress` to a non-existent `failed` status.
**Why it happens:** CONTEXT.md mentions "failed" conceptually, but TaskStatus has no `failed` value.
**How to avoid:** Use `in-progress -> blocked` (which is a valid transition per `VALID_TRANSITIONS`). The existing retry mechanism handles `blocked -> ready` automatically.

### Pitfall 5: Tool Call Count Not Available in onRunComplete
**What goes wrong:** The diagnostic message says "Session had N tool calls" but `AgentRunOutcome` only has `taskId`, `sessionId`, `success`, `aborted`, `error`, `durationMs`. No tool call count.
**Why it happens:** Tool call counting requires parsing the session JSONL, which is Phase 26 (ENFC-03).
**How to avoid:** For Phase 25, include `durationMs` in the diagnostic but use "unknown" or omit tool call count. The forward reference to `aof trace` will provide this data once Phase 27 ships. Alternatively, use a placeholder like "N" that Phase 26 can later populate.

### Pitfall 6: Double Failure Tracking
**What goes wrong:** Both the enforcement path AND the spawn failure path call `trackDispatchFailure`, potentially double-counting.
**Why it happens:** The enforcement failure is a NEW failure type (agent exited without completing), distinct from spawn failures.
**How to avoid:** The enforcement path fires in `onRunComplete` (post-agent-exit), while spawn failures fire in the `if (!result.success)` branch (pre-agent-start). These are mutually exclusive code paths -- no double-counting risk.

## Code Examples

### New Event Type Addition (schemas/event.ts)
```typescript
// Add to EventType z.enum array:
"completion.enforcement",
```

### SKILL.md Addition (~40 tokens)
```markdown
## Completion Protocol

Always call `aof_task_complete` with a brief summary when done. Exiting without this call fails the task and triggers retry. Include what you did and any artifacts produced.
```

### Enhanced formatTaskInstruction() (openclaw-executor.ts)
```typescript
instruction += `\n\n**COMPLETION REQUIREMENT:** You MUST call \`aof_task_complete\` ` +
  `with taskId="${context.taskId}" when finished. If you exit without calling this tool, ` +
  `the task will be marked as FAILED and retried by another agent. ` +
  `Include a brief summary of actions taken and artifacts produced.`;
```

### Enforcement Event Payload
```typescript
await logger.log("completion.enforcement", "scheduler", {
  taskId: action.taskId,
  payload: {
    agent: action.agent,
    sessionId: outcome.sessionId,
    durationMs: outcome.durationMs,
    correlationId,
    reason: "agent_exited_without_completion",
    dispatchFailures: updatedTask?.frontmatter.metadata.dispatchFailures,
  },
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Auto-complete on agent exit (dispatch.fallback) | Block on agent exit (completion.enforcement) | Phase 25 | Silent failures become visible, retry-able failures |
| Trust agent exit code | Require explicit completion signal | Phase 25 | Hallucinated completions are caught |

**Deprecated after Phase 25:**
- `dispatch.fallback` event type: replaced by `completion.enforcement`. The event type should remain in the enum for backward compatibility with existing log readers, but no code should emit it.
- Auto-completion path in `onRunComplete`: removed entirely.

## Open Questions

1. **Tool call count in diagnostic message**
   - What we know: `AgentRunOutcome` does not include tool call count. Session JSONL parsing is Phase 26.
   - What's unclear: Should the Phase 25 diagnostic message include a placeholder or omit tool call count entirely?
   - Recommendation: Include `durationMs` only. Use format: "Task failed: agent exited without calling aof_task_complete. Session lasted Xs. Run `aof trace <task-id>` for details." Tool call count added in Phase 26.

2. **DAG hop enforcement implementation**
   - What we know: `dispatchDAGHop` in `dag-transition-handler.ts` does not pass `onRunComplete`. The function signature would need to change.
   - What's unclear: Should we modify `dispatchDAGHop`'s signature or add a wrapper in the scheduler?
   - Recommendation: Modify `dispatchDAGHop` to accept an optional `onRunComplete` callback, consistent with `spawnSession` interface.

3. **Backward compatibility of dispatch.fallback event**
   - What we know: Existing log analysis may filter on `dispatch.fallback`.
   - Recommendation: Keep `dispatch.fallback` in the EventType enum but stop emitting it. New code emits `completion.enforcement` only.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (via `scripts/test-lock.sh run`) |
| Config file | `vitest.config.ts` (root) + `tests/integration/vitest.config.ts` |
| Quick run command | `npx vitest run src/dispatch/__tests__/ --reporter=verbose` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ENFC-01 | Agent exit without aof_task_complete -> task blocked + failure tracked | unit | `npx vitest run src/dispatch/__tests__/completion-enforcement.test.ts -x` | Wave 0 |
| ENFC-01 | DAG hop enforcement on agent exit without completion | unit | `npx vitest run src/dispatch/__tests__/dag-completion-enforcement.test.ts -x` | Wave 0 |
| ENFC-04 | completion.enforcement event emitted on enforcement | unit | `npx vitest run src/dispatch/__tests__/completion-enforcement.test.ts -x` | Wave 0 |
| ENFC-04 | Event type valid in schema | unit | `npx vitest run src/schemas/__tests__/golden-fixture.test.ts -x` | Existing (update fixture) |
| GUID-01 | SKILL.md contains completion instructions | unit | `npx vitest run src/context/__tests__/context-budget-gate.test.ts -x` | Existing (validates budget) |
| GUID-02 | formatTaskInstruction includes completion consequences | unit | `npx vitest run src/openclaw/__tests__/executor.test.ts -x` | Existing (extend) |

### Sampling Rate
- **Per task commit:** `npx vitest run src/dispatch/__tests__/ --reporter=verbose`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/dispatch/__tests__/completion-enforcement.test.ts` -- covers ENFC-01 (top-level) + ENFC-04
- [ ] `src/dispatch/__tests__/dag-completion-enforcement.test.ts` -- covers ENFC-01 (DAG path)
- [ ] Extend `src/openclaw/__tests__/executor.test.ts` -- covers GUID-02 (enhanced instruction text)

## Sources

### Primary (HIGH confidence)
- Direct code reading: `src/dispatch/assign-executor.ts` (lines 172-227) -- onRunComplete callback
- Direct code reading: `src/dispatch/failure-tracker.ts` -- trackDispatchFailure, shouldTransitionToDeadletter
- Direct code reading: `src/schemas/task.ts` (lines 18-27, 150-158) -- TaskStatus enum, VALID_TRANSITIONS
- Direct code reading: `src/schemas/event.ts` -- EventType enum (142 entries)
- Direct code reading: `src/openclaw/openclaw-executor.ts` (lines 301-317) -- formatTaskInstruction
- Direct code reading: `src/dispatch/dag-transition-handler.ts` -- dispatchDAGHop (no onRunComplete)
- Direct code reading: `src/protocol/router.ts` (lines 286-330) -- handleSessionEnd DAG path
- Direct code reading: `src/dispatch/executor.ts` -- AgentRunOutcome type (no toolCallCount field)
- Direct code reading: `skills/aof/SKILL.md` -- current content, 194 lines
- Direct code reading: `src/context/__tests__/context-budget-gate.test.ts` -- budget ceiling 2150 tokens

### Secondary (MEDIUM confidence)
- None required -- all findings from direct code reading.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all changes to existing modules
- Architecture: HIGH -- exact code locations identified, modification patterns clear
- Pitfalls: HIGH -- race conditions, state machine constraints, and budget limits verified from code

**Research date:** 2026-03-07
**Valid until:** 2026-04-07 (stable codebase, no external dependency changes)
