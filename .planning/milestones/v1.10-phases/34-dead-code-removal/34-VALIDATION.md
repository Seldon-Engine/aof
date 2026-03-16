---
phase: 34
slug: dead-code-removal
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 34 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^3.0.0 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `./scripts/test-lock.sh run` |
| **Full suite command** | `./scripts/test-lock.sh run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx tsc --noEmit && ./scripts/test-lock.sh run`
- **After every plan wave:** Run `./scripts/test-lock.sh run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 34-01-01 | 01 | 1 | DEAD-01 | smoke | `npx tsc --noEmit` | N/A (compile check) | ⬜ pending |
| 34-01-02 | 01 | 1 | DEAD-02 | smoke | `ls src/dispatch/__tests__/gate-*.test.ts 2>/dev/null; echo $?` | N/A (file absence check) | ⬜ pending |
| 34-01-03 | 01 | 1 | DEAD-03 | smoke | `grep -c 'gate' src/schemas/index.ts src/dispatch/index.ts` | N/A (grep check) | ⬜ pending |
| 34-01-04 | 01 | 1 | DEAD-04 | unit | `./scripts/test-lock.sh run -- --run src/store/__tests__/` | ✅ | ⬜ pending |
| 34-01-05 | 01 | 1 | DEAD-05 | smoke | `npx tsc --noEmit` | N/A (compile check) | ⬜ pending |
| 34-01-06 | 01 | 1 | DEAD-06 | smoke | `npx tsc --noEmit` | N/A (compile check) | ⬜ pending |
| 34-01-07 | 01 | 1 | DEAD-07 | smoke | `grep -c 'DispatchExecutor\|ExecutorResult\|MockExecutor' src/dispatch/executor.ts` | N/A (grep check) | ⬜ pending |
| 34-01-08 | 01 | 1 | DEAD-08 | smoke | Manual inspection | N/A | ⬜ pending |
| 34-01-09 | 01 | 1 | DEAD-09 | smoke | `grep -c '@deprecated.*notifier' src/service/aof-service.ts` | N/A (grep check) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements. No new tests need to be written. This phase only deletes code and tests.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| No commented-out code in event.ts, promotion.ts | DEAD-08 | Requires human judgment on what constitutes "commented-out code" vs legitimate comments | Inspect event.ts and promotion.ts for blocks of commented-out logic |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
