---
phase: 40
slug: test-infrastructure
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 40 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3.2.4 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 40-01-01 | 01 | 1 | TEST-01 | unit | `npx vitest run src/testing/__tests__/harness.test.ts -x` | ❌ W0 | ⬜ pending |
| 40-01-02 | 01 | 1 | TEST-02 | unit | `npx vitest run src/testing/__tests__/mock-store.test.ts -x` | ❌ W0 | ⬜ pending |
| 40-01-03 | 01 | 1 | TEST-02 | unit | `npx vitest run src/testing/__tests__/mock-logger.test.ts -x` | ❌ W0 | ⬜ pending |
| 40-01-04 | 01 | 1 | TEST-05 | unit | `npx vitest run src/testing/__tests__/harness.test.ts -x` | ❌ W0 | ⬜ pending |
| 40-02-01 | 02 | 2 | TEST-01 | integration | `npx vitest run --reporter=verbose` | ✅ | ⬜ pending |
| 40-02-02 | 02 | 2 | TEST-03 | smoke | `npx vitest run --coverage 2>&1 \| head -50` | N/A | ⬜ pending |
| 40-02-03 | 02 | 2 | TEST-04 | manual-only | Grep for mkdtemp files without cleanup | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/testing/__tests__/harness.test.ts` — stubs for TEST-01, TEST-05 (createTestHarness, withTestProject, bound utilities)
- [ ] `src/testing/__tests__/mock-store.test.ts` — stubs for TEST-02 (createMockStore returns full ITaskStore)
- [ ] `src/testing/__tests__/mock-logger.test.ts` — stubs for TEST-02 (createMockLogger returns full EventLogger mock)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Temp dir cleanup in all test files | TEST-04 | Code review of 15 files | Grep for mkdtemp without corresponding rm/cleanup in afterEach |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
