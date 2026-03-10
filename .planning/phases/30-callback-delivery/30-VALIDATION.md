---
phase: 30
slug: callback-delivery
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 30 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^3.0.0 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 30-01-T1 | 01 | 1 | SUB schema | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts` | ❌ W0 | ⬜ pending |
| 30-01-T2 | 01 | 1 | DLVR-01, DLVR-02, DLVR-03, DLVR-04, GRAN-01 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts` | ❌ W0 | ⬜ pending |
| 30-02-T1 | 02 | 2 | DLVR-01, DLVR-02, DLVR-04 | unit | `npx vitest run src/dispatch/__tests__/callback-integration.test.ts` | ❌ W0 | ⬜ pending |
| 30-02-T2 | 02 | 2 | ORG-VAL | unit | `npx vitest run src/mcp/__tests__/tools.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/dispatch/__tests__/callback-delivery.test.ts` — stubs for DLVR-01, DLVR-02, DLVR-03, DLVR-04, GRAN-01
- [ ] Extended tests in `src/store/__tests__/subscription-store.test.ts` — schema extension + update method
- [ ] Extended tests for org chart validation in subscribe handlers

*Existing test infrastructure (vitest, test helpers) covers framework needs.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
