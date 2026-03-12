---
phase: 35
slug: bug-fixes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 35 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npm run test:unlocked -- --reporter=verbose` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm run test:unlocked -- --reporter=verbose`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 35-01-01 | 01 | 1 | BUG-01 | unit | `npx vitest run src/dispatch/__tests__/scheduler-helpers.test.ts -x` | ❌ W0 | ⬜ pending |
| 35-01-02 | 01 | 1 | BUG-01 | unit | `npx vitest run src/dispatch/__tests__/scheduler.test.ts -x` | ✅ (extend) | ⬜ pending |
| 35-01-03 | 01 | 1 | BUG-02 | unit | `npx vitest run src/daemon/__tests__/daemon.test.ts -x` | ✅ (extend) | ⬜ pending |
| 35-01-04 | 01 | 1 | BUG-03 | type-check | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 35-01-05 | 01 | 1 | BUG-04 | unit | `npx vitest run src/dispatch/__tests__/assign-executor.test.ts -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/dispatch/__tests__/scheduler-helpers.test.ts` — stubs for BUG-01 (buildTaskStats with all 8 statuses)
- [ ] Extend `src/dispatch/__tests__/assign-executor.test.ts` — BUG-04 lock manager wiring tests

*Existing infrastructure covers BUG-02 (daemon tests) and BUG-03 (tsc type-check).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `/status` endpoint uptime after restart | BUG-02 | Requires daemon restart cycle | Start daemon, wait, restart, check `/status` uptime < 5s |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
