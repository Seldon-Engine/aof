---
phase: 38
slug: code-refactoring
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 38 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^3.0.0 |
| **Config file** | vitest.config.ts (root) |
| **Quick run command** | `npx vitest run src/dispatch/__tests__/assign-executor.test.ts --reporter=verbose` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 38-01-01 | 01 | 1 | REF-01 | unit | `npx vitest run src/dispatch/__tests__/assign-helpers.test.ts -x` | ❌ W0 | ⬜ pending |
| 38-01-02 | 01 | 1 | REF-04 | unit | `npx vitest run src/dispatch/__tests__/callback-helpers.test.ts -x` | ❌ W0 | ⬜ pending |
| 38-01-03 | 01 | 1 | REF-05 | unit | `npx vitest run src/dispatch/__tests__/trace-helpers.test.ts -x` | ❌ W0 | ⬜ pending |
| 38-02-01 | 02 | 1 | REF-02 | unit | `npx vitest run src/dispatch/__tests__/lifecycle-handlers.test.ts -x` | ❌ W0 | ⬜ pending |
| 38-02-02 | 02 | 1 | REF-02 | unit | `npx vitest run src/dispatch/__tests__/recovery-handlers.test.ts -x` | ❌ W0 | ⬜ pending |
| 38-02-03 | 02 | 1 | REF-02 | unit | `npx vitest run src/dispatch/__tests__/alert-handlers.test.ts -x` | ❌ W0 | ⬜ pending |
| 38-03-01 | 03 | 2 | REF-03 | unit | `npx vitest run src/tools/__tests__/tool-registry.test.ts -x` | ❌ W0 | ⬜ pending |
| 38-03-02 | 03 | 2 | REF-07 | unit | `npx vitest run src/openclaw/__tests__/permissions.test.ts -x` | ❌ W0 | ⬜ pending |
| 38-03-03 | 03 | 2 | REF-08 | integration | `npx vitest run src/mcp/__tests__/ -x` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/dispatch/__tests__/assign-helpers.test.ts` — stubs for REF-01
- [ ] `src/dispatch/__tests__/callback-helpers.test.ts` — stubs for REF-04
- [ ] `src/dispatch/__tests__/trace-helpers.test.ts` — stubs for REF-05
- [ ] `src/dispatch/__tests__/lifecycle-handlers.test.ts` — stubs for REF-02 (partial)
- [ ] `src/dispatch/__tests__/recovery-handlers.test.ts` — stubs for REF-02 (partial)
- [ ] `src/dispatch/__tests__/alert-handlers.test.ts` — stubs for REF-02 (partial)
- [ ] `src/tools/__tests__/tool-registry.test.ts` — stubs for REF-03
- [ ] `src/openclaw/__tests__/permissions.test.ts` — stubs for REF-07

*Existing tests (`assign-executor.test.ts`, `completion-enforcement.test.ts`, `callback-delivery.test.ts`) provide integration-level regression coverage and MUST remain green throughout.*

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
