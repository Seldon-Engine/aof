---
phase: 31
slug: granularity-safety-and-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 31 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 31-01-01 | 01 | 0 | GRAN-02, SAFE-01, SAFE-02 | unit stubs | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts` | ❌ W0 | ⬜ pending |
| 31-02-01 | 02 | 1 | GRAN-02 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "all granularity"` | ❌ W0 | ⬜ pending |
| 31-02-02 | 02 | 1 | GRAN-02 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "lastDeliveredAt"` | ❌ W0 | ⬜ pending |
| 31-02-03 | 02 | 1 | GRAN-02 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "transition list"` | ❌ W0 | ⬜ pending |
| 31-03-01 | 03 | 1 | SAFE-01 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "depth"` | ❌ W0 | ⬜ pending |
| 31-03-02 | 03 | 1 | SAFE-01 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "depth_exceeded"` | ❌ W0 | ⬜ pending |
| 31-03-03 | 03 | 1 | SAFE-01 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "callbackDepth"` | ❌ W0 | ⬜ pending |
| 31-04-01 | 04 | 1 | SAFE-02 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "recovery"` | ❌ W0 | ⬜ pending |
| 31-04-02 | 04 | 1 | SAFE-02 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "recovery_attempted"` | ❌ W0 | ⬜ pending |
| 31-04-03 | 04 | 1 | SAFE-02 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "retry persist"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] New test cases in `src/dispatch/__tests__/callback-delivery.test.ts` for all-granularity scanning, depth limiting, and recovery scan
- [ ] Schema validation tests for `lastDeliveredAt` and `callbackDepth` fields (tested implicitly via unit tests)

*Existing vitest infrastructure covers framework needs.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
