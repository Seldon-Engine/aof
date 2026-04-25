---
phase: 46
slug: daemon-state-freshness
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-24
---

# Phase 46 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.x (existing) |
| **Config file** | `vitest.config.ts` (existing) |
| **Quick run command** | `npx vitest run <changed-file-glob>` |
| **Full suite command** | `npm test` (~3000 unit tests, ~57s) |
| **E2E command** | `npm run test:e2e` (~224 tests, sequential, ~60s) |
| **Estimated runtime** | unit ~57s, e2e ~60s |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run` scoped to the modified file's `__tests__/` neighbor.
- **After every plan wave:** Run `npm test` full unit suite.
- **Before `/gsd-verify-work`:** Full unit suite + `npm run test:e2e` must both be green.
- **Max feedback latency:** 60s for unit, 120s for e2e.

Per CLAUDE.md: **always `kill -9` vitest workers after any aborted run** (vitest's tinypool leaks workers under SIGTERM).

---

## Per-Task Verification Map

Sourced from RESEARCH.md "Validation Architecture" section. Six plans expected; per-task IDs assigned during planning.

**Wave structure (post-revision):** All 6 plans flattened to **Wave 1, depends_on: []**. The planner's revision verified that Plan 02's reconcileDrift uses raw `rename()` (not `store.transition()`), making it independent of Plan 01's atomicity work. `files_modified` sets are pairwise disjoint across all 6 plans.

| Plan | Bug | Wave | Test Type | Test Anchor (existing or new) | Validation invariant |
|------|-----|------|-----------|-------------------------------|---------------------|
| 01 | 1A — atomic transition | 1 | unit + integration | new `src/dispatch/__tests__/bug-046a-atomic-transition.test.ts` | A failed move during transition leaves both frontmatter status AND directory unchanged (rollback). On success, both committed atomically. |
| 02 | 1A — reconciliation pass | 1 | integration | new `src/store/__tests__/bug-046a-startup-reconciliation.test.ts` | Files in `tasks/<X>/` whose `frontmatter.status === Y ≠ X` are physically moved to `tasks/<Y>/` on `init()`. Files matching their dir untouched. Q3 duplicate-detection deferred (see Plan 02 must_haves rationale). |
| 03 | 2A — project rediscovery | 1 | integration | new `src/service/__tests__/bug-046b-project-rediscovery.test.ts` | Project created AFTER `AOFService.init()` becomes visible to `poll()` within one cycle. Rediscovery happens inside the existing `pollQueue` serialization (no race). |
| 04 | 1C — log rotation | 1 | unit + smoke | new `src/logging/__tests__/bug-046c-rotation-wired.test.ts`; manual smoke for plist/launchd path | (a) `pino-roll` transport configured with size 50M, count 5, mkdir true. (b) `fd: 2` is NOT a destination — pino does NOT write to stderr. (c) Test-only `__setLoggerTransportForTests` escape hatch keeps logger.test.ts free of sleep/setTimeout. Manual: launchd-stderr.log no longer grows during normal operation. |
| 05 | 2B — routing validation | 1 | unit | new `src/tools/__tests__/bug-046d-routing-required.test.ts` | `aof_dispatch` rejects payloads with empty `routing.agent`/`routing.role`/`routing.team` UNLESS project owner provides a defaultable target. Treats `owner.team`/`owner.lead === "system"` (case-insensitive) as no-default sentinel and falls through to rejection. |
| 06 | 2C — actor injection | 1 | unit | new `src/ipc/__tests__/bug-046e-actor-injection.test.ts` + new `src/openclaw/__tests__/bug-046e-dispatch-notification-actor.test.ts` | (a) IPC route `/v1/tool/invoke` injects `envelope.actor` into `inner.data.actor` when undefined; explicit `inner.data.actor` takes precedence. (b) Plugin-side `mergeDispatchNotificationRecipient` falls back `params.actor → captured.actor` when missing. |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky — populated during execution.*

**Sampling continuity check:** Every plan has at least one automated test. No more than 1 plan (Plan 04 manual smoke) involves manual verification, and even that has automated unit coverage for the code-level wiring.

---

## Wave 0 Requirements

Wave 0 captures pre-existing test infrastructure gaps the planner needs to fill before TDD can run.

- [ ] No new framework install required — vitest 3.x already in place.
- [ ] `src/store/__tests__/` — exists, neighbors for Plans 01/02.
- [ ] `src/service/__tests__/` — verify exists for Plan 03 home; if missing, planner creates the dir + a baseline test for Plan 03 to extend.
- [ ] `src/logging/__tests__/` — likely missing (small module today). Planner creates if needed.
- [ ] `src/tools/__tests__/` — exists, neighbor for Plan 05.
- [ ] `src/ipc/__tests__/` — exists, neighbor for Plan 06.

If any `__tests__/` dir is missing, the first plan touching that dir must include a Wave 0 task to create it with a baseline import-and-pass test. Planner: confirm and inject as needed.

---

## Manual-Only Verifications

| Behavior | Plan | Why Manual | Test Instructions |
|----------|------|------------|-------------------|
| launchd-stderr log no longer grows during normal operation | 04 | Requires the actual launchd plist + a running daemon over multiple poll cycles; not feasible in unit test | After deploy, `ls -lh ~/.aof/data/logs/daemon-stderr.log` should remain at near-zero bytes after a 5-minute idle period. The pino-rotated file (`daemon.log` or similar — TBD by planner) is the active log. |
| Newly-created project is dispatched without daemon restart | 03 | E2E confirmation against real OpenClaw + filesystem; unit test covers the in-memory invariant but the real-install confirmation is the user-facing assertion | After deploy: `aof project create event-test`; create a task with explicit routing; observe daemon log within 30s shows scheduler picking up the task; transition completes. |
| 172MB log incident does not recur | 04 | Negative confirmation — testable only by elapsed time without recurrence | Monitor log file sizes for 1 week post-deploy. Log rotation should keep total disk use under ~250MB even under stress. |

---

## Validation Sign-Off

- [ ] All 6 plans have at least one `<automated>` verify or Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive plans without automated verify (we have automated for all 6)
- [ ] Wave 0 covers all MISSING `__tests__/` references (planner to confirm during planning)
- [ ] No watch-mode flags in any test command
- [ ] Feedback latency < 60s for unit, < 120s for e2e
- [ ] `nyquist_compliant: true` set in frontmatter (after planner sign-off and Wave 0 confirmation)

**Approval:** pending — set to approved YYYY-MM-DD after planner validates per-plan test anchors land as designed.
