---
phase: 25-completion-enforcement
plan: 02
subsystem: agent-guidance
tags: [skill-md, openclaw, agent-instructions, completion-enforcement]

# Dependency graph
requires:
  - phase: 24-budget-gate
    provides: "Budget gate test infrastructure and SKILL.md token ceiling"
provides:
  - "SKILL.md completion protocol section instructing agents about aof_task_complete"
  - "Enhanced formatTaskInstruction with FAILED/retry enforcement consequences"
affects: [26-trace-infrastructure, 27-trace-cli]

# Tech tracking
tech-stack:
  added: []
  patterns: [dual-channel-agent-guidance]

key-files:
  created: []
  modified:
    - skills/aof/SKILL.md
    - src/openclaw/openclaw-executor.ts
    - src/openclaw/__tests__/executor.test.ts
    - src/context/__tests__/context-budget-gate.test.ts

key-decisions:
  - "Trimmed completion protocol to ~30 tokens to stay within 50% reduction threshold (1705 token limit)"
  - "Replaced soft IMPORTANT wording with explicit COMPLETION REQUIREMENT enforcement block"

patterns-established:
  - "Dual-channel agent guidance: SKILL.md (standing context) + formatTaskInstruction (per-dispatch reinforcement)"

requirements-completed: [GUID-01, GUID-02]

# Metrics
duration: 9min
completed: 2026-03-07
---

# Phase 25 Plan 02: Agent Guidance Summary

**Dual-channel completion enforcement: SKILL.md completion protocol section and formatTaskInstruction FAILED/retry consequences**

## Performance

- **Duration:** 9 min
- **Started:** 2026-03-07T19:55:42Z
- **Completed:** 2026-03-07T20:05:08Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Added "Completion Protocol" section to SKILL.md within budget gate ceiling (under 2150 tokens)
- Enhanced formatTaskInstruction() with explicit enforcement: task marked FAILED and retried by another agent
- Both instruction channels now tell agents about aof_task_complete requirement and consequences
- All budget gate and executor tests pass (22 tests across 2 suites)

## Task Commits

Each task was committed atomically:

1. **Task 1: Update SKILL.md with completion protocol section**
   - `adf0713` test(25-02): add failing test for SKILL.md completion protocol content
   - `f0050a0` feat(25-02): add completion protocol section to SKILL.md
2. **Task 2: Enhance formatTaskInstruction with enforcement consequences**
   - `7497dd7` test(25-02): add failing tests for formatTaskInstruction enforcement
   - `8c696ba` feat(25-02): enhance formatTaskInstruction with enforcement consequences

_TDD tasks: RED (failing test) then GREEN (implementation) for each task._

## Files Created/Modified
- `skills/aof/SKILL.md` - Added Completion Protocol section (~30 tokens)
- `src/openclaw/openclaw-executor.ts` - Replaced IMPORTANT block with COMPLETION REQUIREMENT enforcement
- `src/openclaw/__tests__/executor.test.ts` - Added 3 tests for enforcement language (FAILED, retried, summary)
- `src/context/__tests__/context-budget-gate.test.ts` - Added test for completion protocol content in SKILL.md

## Decisions Made
- Trimmed "Include what you did and any artifacts produced" from SKILL.md to stay within the 50% reduction threshold (3411 * 0.5 = 1705.5 tokens). The formatTaskInstruction already includes the summary instruction, so the dual-channel approach covers this.
- Used "COMPLETION REQUIREMENT" heading instead of "IMPORTANT" for stronger signal to agents.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Trimmed SKILL.md addition to stay within 50% reduction threshold**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** Plan's exact text (~35 tokens) pushed SKILL.md to 1716 tokens, exceeding the 50% reduction threshold of 1705.5
- **Fix:** Removed "Include what you did and any artifacts produced" sentence from SKILL.md section (kept in formatTaskInstruction instead)
- **Files modified:** skills/aof/SKILL.md
- **Verification:** All 4 budget gate tests pass
- **Committed in:** f0050a0

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minimal -- the summary instruction is still delivered via the formatTaskInstruction channel. No information loss.

## Issues Encountered
- Pre-existing test failures (6 tests in scheduler/deadletter test file) unrelated to this plan's changes. All target test suites pass fully.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Both instruction channels (SKILL.md standing context + per-dispatch reinforcement) now inform agents about the completion requirement
- Ready for Phase 25 Plan 01's enforcement infrastructure to detect and act on missing completions

---
*Phase: 25-completion-enforcement*
*Completed: 2026-03-07*
