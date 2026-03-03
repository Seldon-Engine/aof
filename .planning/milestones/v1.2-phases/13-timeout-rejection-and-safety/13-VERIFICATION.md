---
phase: 13-timeout-rejection-and-safety
verified: 2026-03-03T21:11:43Z
status: passed
score: 19/19 must-haves verified
re_verification: false
---

# Phase 13: Timeout, Rejection, and Safety Verification Report

**Phase Goal:** DAG execution handles failure modes gracefully — timeouts escalate, rejections cascade correctly, and agent-authored conditions are sandboxed
**Verified:** 2026-03-03T21:11:43Z
**Status:** PASSED
**Re-verification:** No — initial verification (retroactive; phase executed 2026-03-03)

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Condition expressions exceeding max nesting depth (5) are rejected by validateDAG with an actionable error message | VERIFIED | `workflow-dag.ts:477-481` — `measureConditionComplexity` called inside `validateDAG`, pushes error with depth value |
| 2 | Condition expressions exceeding max node count (50) are rejected by validateDAG with an actionable error message | VERIFIED | `workflow-dag.ts:482-487` — node count check in `validateDAG`, pushes error with count value |
| 3 | hop_status operators and hops.X field paths referencing non-existent hop IDs are rejected by validateDAG | VERIFIED | `workflow-dag.ts:490-502` — `collectHopReferences` called, each ref checked against `hopIds` set |
| 4 | parseDuration handles 'd' (days) unit correctly alongside existing 'm' and 'h' units | VERIFIED | `duration-parser.ts:22,33` — regex updated to `[mhd]`, `if (unit === "d") return value * 24 * 60 * 60 * 1000` |
| 5 | HopState schema accepts optional rejectionCount and escalated fields | VERIFIED | `workflow-dag.ts:190-192` — `rejectionCount: z.number().int().nonnegative().optional()`, `escalated: z.boolean().optional()` |
| 6 | EventType enum includes dag.hop_timeout, dag.hop_timeout_escalation, dag.hop_rejected, dag.hop_rejection_cascade | VERIFIED | `event.ts:138-141` — all 4 event types present under "DAG safety (Phase 13)" comment |
| 7 | hop_timeout_escalation is in ALWAYS_CRITICAL_EVENTS set | VERIFIED | `severity.ts:24` — `"dag.hop_timeout_escalation"` present in Set |
| 8 | A dispatched hop that exceeds its configured timeout triggers escalation to the escalateTo role | VERIFIED | `escalation.ts:476-492` — `escalateHopTimeout` force-completes then spawns new session with `escalateToRole` |
| 9 | The timed-out agent's session is force-completed before re-dispatch to escalateTo | VERIFIED | `escalation.ts:325-331` — `config.executor.forceCompleteSession(hopState.correlationId)` called before spawn |
| 10 | When escalateTo is not configured, an alert event is emitted but hop status is unchanged | VERIFIED | `escalation.ts:288-309` — logs `dag.hop_timeout`, returns alert action, no state mutation |
| 11 | One-shot escalation only — if an already-escalated hop times out again, alert only, no re-escalation | VERIFIED | `escalation.ts:263-285` — `if (hopState.escalated)` guard logs and returns early |
| 12 | Timeout checking runs in the poll cycle alongside checkGateTimeouts | VERIFIED | `scheduler.ts:249` — `const hopTimeoutActions = await checkHopTimeouts(store, logger, config, metrics)` at step 3.10 |
| 13 | Hop timeout uses startedAt timestamp on HopState to calculate elapsed time | VERIFIED | `escalation.ts:472-476` — `const startedAt = new Date(hopState.startedAt).getTime(); const elapsed = now - startedAt` |
| 14 | A rejected hop triggers cascade reset of downstream hops according to the configured rejection strategy | VERIFIED | `dag-evaluator.ts:471-528` — `if (event.outcome === "rejected")` block with strategy branching |
| 15 | Origin strategy resets ALL hops to pending/ready — full DAG restart | VERIFIED | `dag-evaluator.ts:354-382` — `resetAllHopsForOrigin` iterates all hops, sets root to "ready", others to "pending" |
| 16 | Predecessors strategy resets rejected hop + its immediate dependsOn predecessors only; completed parallel branches stay done | VERIFIED | `dag-evaluator.ts:400-443` — `resetPredecessorHops` builds `resetSet = [rejectedHopId, ...rejectedHop.dependsOn]`, hops outside set untouched |
| 17 | rejectionCount persists across resets and increments on each rejection | VERIFIED | `dag-evaluator.ts:473` — `currentCount = (newState.hops[event.hopId]?.rejectionCount ?? 0) + 1`; preserved on reset hop |
| 18 | After N rejections (default 3), the hop fails permanently (circuit-breaker) and downstream hops are skip-cascaded | VERIFIED | `dag-evaluator.ts:475-491` — `if (currentCount >= DEFAULT_MAX_REJECTIONS)` sets status "failed", calls `cascadeSkips` |
| 19 | Rejection is triggered by needs_review run result outcome on a canReject hop | VERIFIED | `dag-transition-handler.ts:102-103` — `if (runResult.outcome === "needs_review" && hopDef?.canReject) { outcome = "rejected" }` |

**Score:** 19/19 truths verified

---

## Required Artifacts

### Plan 01 Artifacts (SAFE-01)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/schemas/workflow-dag.ts` | measureConditionComplexity + collectHopReferences functions, HopState with rejectionCount/escalated | VERIFIED | Both functions exported (lines 268-336), HopState extended (lines 190-192), validateDAG wired (lines 473-502) |
| `src/dispatch/duration-parser.ts` | parseDuration with d unit support | VERIFIED | Regex `[mhd]` at line 22, d-unit branch at line 33 |
| `src/schemas/event.ts` | DAG safety event types | VERIFIED | All 4 event types present at lines 138-141 |

### Plan 02 Artifacts (SAFE-03)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/dispatch/escalation.ts` | checkHopTimeouts + escalateHopTimeout functions | VERIFIED | `checkHopTimeouts` exported (line 429), `escalateHopTimeout` internal (line 248), 574-line substantive file |
| `src/dispatch/__tests__/dag-timeout.test.ts` | TDD tests for hop timeout + escalation | VERIFIED | 574 lines, 27 references to checkHopTimeouts pattern |
| `src/dispatch/scheduler.ts` | Poll cycle integration for hop timeout checking | VERIFIED | `checkHopTimeouts` imported (line 31) and called (line 249) |

### Plan 03 Artifacts (SAFE-04)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/dispatch/dag-evaluator.ts` | Rejection cascade logic in evaluateDAG + helper functions | VERIFIED | "rejected" in HopEvent outcome (line 49), `DEFAULT_MAX_REJECTIONS` (line 119), `resetAllHopsForOrigin` (line 354), `resetPredecessorHops` (line 400), rejection path in `evaluateDAG` (lines 471-528) |
| `src/dispatch/__tests__/dag-rejection.test.ts` | TDD tests for rejection cascade and circuit-breaker | VERIFIED | 606 lines, 67 references to rejected/rejection patterns |
| `src/dispatch/dag-transition-handler.ts` | Updated mapRunResultToHopEvent with rejected outcome + handleDAGHopCompletion rejection flow | VERIFIED | `mapRunResultToHopEvent` handles `needs_review + canReject` (lines 102-103), `handleDAGHopCompletion` logs `dag.hop_rejected` (lines 222-233) |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `src/schemas/workflow-dag.ts` | `validateDAG` | measureConditionComplexity + collectHopReferences called within validateDAG | VERIFIED | Lines 476, 493 — both called inside validateDAG |
| `src/dispatch/scheduler.ts` | `src/dispatch/escalation.ts` | poll() calls checkHopTimeouts() | VERIFIED | `scheduler.ts:31` imports, `scheduler.ts:249` calls `checkHopTimeouts` |
| `src/dispatch/escalation.ts` | direct spawn (not dispatchDAGHop) | escalateHopTimeout spawns directly via executor.spawnSession | VERIFIED (design deviation) | Plan specified `dispatchDAGHop`; implementation uses `executor.spawnSession` directly — documented in both PLAN and SUMMARY as intentional. Functional outcome (escalation to new role) is achieved. |
| `src/dispatch/dag-transition-handler.ts` | `src/dispatch/dag-evaluator.ts` | mapRunResultToHopEvent maps needs_review to rejected, evaluateDAG handles it | VERIFIED | `dag-transition-handler.ts:102-103` maps to "rejected"; `dag-evaluator.ts:471` handles `event.outcome === "rejected"` |
| `src/dispatch/dag-evaluator.ts` | `src/schemas/workflow-dag.ts` | Rejection reads rejectionStrategy from Hop definition, updates rejectionCount on HopState | VERIFIED | `dag-evaluator.ts:494` reads `hopDef.rejectionStrategy`; lines 370, 433 update `rejectionCount` |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SAFE-01 | 13-01 | Hop conditions use a restricted JSON DSL (no eval/new Function) for agent-composed workflows | SATISFIED | validateDAG enforces depth<=5, nodes<=50, valid hop refs; ConditionExpr is a Zod discriminated union DSL — no eval/Function paths exist |
| SAFE-03 | 13-02 | Each hop supports timeout with escalation to a specified role | SATISFIED | checkHopTimeouts + escalateHopTimeout implement full timeout/escalation with one-shot rule and force-complete |
| SAFE-04 | 13-03 | Hop rejection resets downstream hops and re-dispatches (configurable rejection strategy) | SATISFIED | evaluateDAG handles "rejected" outcome with origin/predecessors strategies, circuit-breaker at DEFAULT_MAX_REJECTIONS=3 |

No orphaned requirements detected — all three requirements (SAFE-01, SAFE-03, SAFE-04) were claimed and satisfied by their respective plans.

---

## Anti-Patterns Found

| File | Pattern | Severity | Assessment |
|------|---------|----------|------------|
| `src/dispatch/dag-transition-handler.ts` | `hopDef` parameter is optional (`hopDef?: { canReject?: boolean }`) | Info | Defensive API design — callers without hop definition get "complete" fallback. Intentional. |
| `src/dispatch/escalation.ts` | `console.warn` for invalid timeout format | Info | Same pattern as existing gate timeout code. Acceptable for scheduler noise. |

No blocker or warning anti-patterns found. No TODO/FIXME/placeholder markers found in phase 13 files. No stub implementations detected.

---

## Human Verification Required

None. All behaviors are verifiable from code structure:

- Condition depth/node limits: enforced in `validateDAG` via constants, grep-verifiable
- Timeout escalation: full implementation in `escalation.ts`, tests in `dag-timeout.test.ts`
- Rejection cascade: full implementation in `dag-evaluator.ts`, tests in `dag-rejection.test.ts`
- Poll cycle wiring: import + call in `scheduler.ts` lines 31 and 249

---

## Commit Verification

All 9 commit hashes from plan summaries are present in git log:

| Commit | Plan | Role |
|--------|------|------|
| `a1f92ee` | 13-01 | test: schema extensions |
| `dab172b` | 13-01 | feat: HopState, event types, duration, severity |
| `1856dae` | 13-01 | test: condition complexity + hop references |
| `ddb126c` | 13-01 | feat: validateDAG condition checks |
| `175ccfa` | 13-02 | test: dag-timeout TDD RED |
| `1f2a5f6` | 13-02 | feat: checkHopTimeouts + scheduler integration |
| `a1d35e7` | 13-03 | test: dag-rejection TDD RED |
| `21ae9ff` | 13-03 | feat: rejection cascade + circuit-breaker |
| `deac448` | 13-03 | refactor: doc comments + DEFAULT_MAX_REJECTIONS export |

---

## Gaps Summary

No gaps. All 19 observable truths are verified by substantive, wired implementations. All three requirement IDs are satisfied.

One design deviation noted: Plan 02 specified `escalateHopTimeout` would call `dispatchDAGHop`, but the implementation correctly spawns directly via `executor.spawnSession` to keep changes contained to `escalation.ts`. This was the explicitly documented "FINAL APPROACH" in the plan and confirmed in the summary. The functional outcome — force-complete followed by re-dispatch to `escalateTo` role — is fully achieved.

---

_Verified: 2026-03-03T21:11:43Z_
_Verifier: Claude (gsd-verifier)_
_Phase context: Retroactive verification — 3 plans, 3 summaries present, no prior VERIFICATION.md_
