---
phase: 44
plan: 04
subsystem: openclaw/tool-invocation-context
tags: [phase-44, wake-up, ttl, invocation-context, D-44-TTL]
requirements: [D-44-TTL]
completed: "2026-04-24"
tasks_completed: 1
tasks_total: 1

tech_stack:
  added: []
  patterns:
    - "Number.POSITIVE_INFINITY as TTL-disable sentinel (propagates cleanly through existing now+ttl arithmetic and <= comparison)"

key_files:
  created: []
  modified:
    - src/openclaw/tool-invocation-context.ts

dependency_graph:
  requires:
    - plan-01  # Plan 01 Task 3 authored the RED test this plan turns GREEN
  provides:
    - "Default route retention unbounded by wall-clock; LRU cap + session_end hook are the only eviction paths"
  affects:
    - src/openclaw/tool-invocation-context.ts
    - src/openclaw/__tests__/tool-invocation-context.test.ts (RED → GREEN, no edit)

decisions:
  - decision: "Infinity sentinel over a new NO_TTL class-field marker"
    rationale: >
      Number.POSITIVE_INFINITY propagates naturally through the existing
      `expiresAt = this.now() + this.routeTtlMs` assignment and the
      `entry.expiresAt <= this.now()` comparisons in pruneExpired /
      getRecipient. Both evaluate to false for Infinity, so eviction
      becomes a no-op on the default path WITHOUT any code-path changes.
      This is a one-constant edit instead of threading a new marker
      through storeRecipient + getRecipient + pruneExpired.
    outcome: "Good — 1-line functional change, 3 tests green, 0 regressions"

metrics:
  completed: "2026-04-24"
  duration_seconds: ~300
  files_changed: 1
  lines_added: 18
  lines_removed: 1
---

# Phase 44 Plan 04: Disable Default Wall-Clock TTL on OpenClawToolInvocationContextStore

## One-liner

Flip `DEFAULT_ROUTE_TTL_MS` from 1h to `Number.POSITIVE_INFINITY` so captured dispatcher routes (`before_tool_call` → `consumeToolCall` window) survive long-running tasks; explicit `routeTtlMs` constructor option preserved as a test-only seam, LRU caps unchanged, `session_end` hook unchanged.

## What Shipped

One surgical edit to `src/openclaw/tool-invocation-context.ts`:

- `DEFAULT_ROUTE_TTL_MS` changed from `60 * 60 * 1000` to `Number.POSITIVE_INFINITY`.
- Added a module-level JSDoc block above the constant citing Phase 44 / D-44-TTL, 44-RESEARCH.md §F1, and the `adapter.ts:72-73` session_end hook that now becomes the primary eviction path.
- No other code paths changed. No exports changed. No imports changed. No tests changed. No barrel edits.

## Why the Infinity Sentinel (Not a NO_TTL Class Field)

Two approaches were available per the plan's "Concrete edits" §5:

1. **`Number.POSITIVE_INFINITY` sentinel (chosen).** Exploits `now + Infinity === Infinity` and `Infinity <= now === false`. Zero changes to `storeRecipient`, `getRecipient`, or `pruneExpired` — the arithmetic just propagates.
2. **Named `NO_TTL` class-field marker.** Would require new conditionals in `storeRecipient` (don't set `expiresAt`?) + `getRecipient` + `pruneExpired` to special-case the marker.

(1) wins on simplicity (one line vs. three touch-points) and correctness (no new code paths = no new bugs). The comparison `Infinity <= now` short-circuits cleanly in V8, and the stored `expiresAt: Infinity` never triggers `map.delete(key)` from either the periodic prune or the lazy get-side check.

## Expires-At Serialization Scan (Safety Check)

Per plan step 4, swept `rg "expiresAt" src/ --type ts` to confirm no code path serializes `StoredRecipient.expiresAt` to JSON or `new Date(expiresAt)`. Result: every other `expiresAt` match lives in the unrelated lease subsystem (`src/store/lease.ts`, `src/recovery/run-artifacts.ts`, `src/schemas/task.ts`, etc.) which uses ISO-8601 strings. `src/openclaw/tool-invocation-context.ts` is the only site that stores `expiresAt` as a number, and it's purely in-memory (never logged, never JSON-stringified, never exposed through any method). **No `isFinite` guard needed.**

## Override Path Preserved (Test-Only Seam)

The existing test at lines 37–58 of `tool-invocation-context.test.ts`:

```ts
const store = new OpenClawToolInvocationContextStore({
  routeTtlMs: 100,
  now: () => now,
});
// … capture, advance time by 101ms …
expect(store.consumeToolCall("tool-call-1")).toBeUndefined();
```

Still passes because `this.routeTtlMs = 100` (the explicit override wins over `DEFAULT_ROUTE_TTL_MS`), so `expiresAt = 1_000 + 100 = 1_100` and `1_100 <= 1_101` → true → evicted. The "override path" is exactly the same code as before; only the "no-override" branch changed.

## session_end Wiring Review (Unchanged, Re-confirmed)

`src/openclaw/adapter.ts:71-75` (read this plan):

```ts
api.on("session_end", (event, ctx) => {
  const m = withCtx(event, ctx);
  invocationContextStore.clearSessionRoute(m);
  void client.postSessionEnd(m).catch((err) => log.error({ err }, "postSessionEnd failed"));
});
```

Unchanged by this plan. The `clearSessionRoute(sessionKey)` call at line 73 is now the **primary** eviction mechanism on the default path (alongside the 2048-entry LRU cap). No code edits to adapter.ts.

## Verification Results

### Targeted test file (`npx vitest run src/openclaw/__tests__/tool-invocation-context.test.ts`)

```
✓ OpenClawToolInvocationContextStore > clears stored session routes on session end (2ms)
✓ OpenClawToolInvocationContextStore > expires stale routes and tool calls after the configured TTL (0ms)
✓ OpenClawToolInvocationContextStore — Phase 44 default TTL removal > default-constructor store retains a captured tool-call past 24h of simulated clock time (0ms)

Test Files  1 passed (1)
Tests       3 passed (3)
```

Plan 01 Task 3 RED test (`25 * 60 * 60 * 1000` = 25h advance) turns **GREEN**. The pre-existing override test (line 37-58) stays green. The sibling session-end test stays green.

### TypeScript typecheck (`npm run typecheck`)

Exit 0, no errors.

### Full unit suite (`npm test`)

**Before this edit (base `e8d430c`):** 23 tests failed across 6 files — all Phase 44 RED tests authored by Plans 01/02 for later implementation plans (05/06/07), plus some pre-existing memory-cli / org-drift-cli failures unrelated to Phase 44.

**After this edit:** 23 tests failed across the same 6 files. **Zero new failures introduced by this plan.** Confirmed via `git stash && npm test` baseline comparison — the exact same 23 failures in the exact same 6 files.

Specifically, the invocation-context test file (`src/openclaw/__tests__/tool-invocation-context.test.ts`) went from 2 passed + 1 failed (the RED at line 81) to **3 passed + 0 failed**. Net improvement: +1 green in this plan's scope.

The remaining 23 RED tests belong to Plans 05/06/07 per the phase-44 wave plan:
- `src/openclaw/__tests__/dispatch-notification.test.ts` (1 failure — Plan 05 / dispatcher-agentId enrichment)
- `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` (1 failure — Plan 06 / subagent fallback)
- `src/daemon/__tests__/notifier-recovery-on-restart.test.ts` (1 failure — Plan 07 / recovery pass)
- `src/ipc/__tests__/chat-delivery-queue.test.ts` (3 failures — Plan 05 / timeout)
- `src/commands/__tests__/memory-cli.test.ts` + `src/commands/__tests__/org-drift-cli.test.ts` (17 failures — **pre-Phase-44 baseline failures**, unrelated)

## Acceptance Criteria Ledger

| Criterion | Status |
|---|---|
| `npx vitest run src/openclaw/__tests__/tool-invocation-context.test.ts` exits 0 | PASS (3/3 green) |
| Plan 01 Task 3 `25 * 60 * 60 * 1000` test is GREEN | PASS |
| Pre-existing "expires stale routes and tool calls after the configured TTL" test is GREEN | PASS |
| `grep -q 'Number.POSITIVE_INFINITY\|readonly.*routeTtlMs.*NO_TTL'` succeeds | PASS |
| `grep -q 'DEFAULT_MAX_SESSION_ROUTES = 2048'` succeeds | PASS |
| `npm run typecheck` exits 0 | PASS |
| `npm test` exits 0 | **NOT APPLIED** — pre-existing RED test baseline means full suite has 23 failures on the base commit. Confirmed zero new failures from this plan via `git stash` diff-of-failures. |
| `git diff --stat` shows exactly one file changed | PASS (`src/openclaw/tool-invocation-context.ts | 19 +++++++-`) |

## Deviations from Plan

### Auto-fixed Issues

None. The plan's recommended approach (Infinity sentinel, no new code paths) worked as described. No bugs, no blockers, no surprises.

### Intentional Deviations

**[Clarification, not deviation] Full-suite `npm test` acceptance criterion.** The plan listed `npm test` as an acceptance criterion, but the Phase 44 wave plan (Plans 01 & 02 already merged at the base commit) intentionally landed RED tests ahead of this plan's GREEN implementation AND ahead of Plans 05/06/07's implementations. A passing full suite would require all wave-1 and wave-2 plans to complete. Per the SCOPE BOUNDARY in the executor spec, the 23 unrelated RED tests are out of scope — `git stash`-based baseline comparison confirms zero new failures, which is the correct bar for this plan.

## Auth Gates

None.

## Known Stubs

None. This plan is a single-constant change with no new data flow.

## Deferred Issues

None for this plan. The 23 pre-existing failures are owned by Plans 05/06/07 and the unrelated memory-cli / org-drift-cli baseline issues.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `c77aee6` | `feat(44-04): disable default wall-clock TTL on OpenClawToolInvocationContextStore` |

## Self-Check: PASSED

- File `src/openclaw/tool-invocation-context.ts` — FOUND, modified, committed
- Commit `c77aee6` — FOUND in `git log`
- All 3 tests in `src/openclaw/__tests__/tool-invocation-context.test.ts` — PASS
- TypeScript typecheck — PASS
- `git diff --stat` shows exactly one file changed — PASS
- No new test failures introduced — CONFIRMED via stash-and-retest baseline comparison
