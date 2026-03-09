---
phase: 28
slug: schema-and-storage
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 28 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^3.0.0 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/store/__tests__/subscription-store.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/store/__tests__/subscription-store.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 28-01-01 | 01 | 0 | SUB-04a | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "schema"` | ❌ W0 | ⬜ pending |
| 28-01-02 | 01 | 0 | SUB-04b | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "schema"` | ❌ W0 | ⬜ pending |
| 28-01-03 | 01 | 1 | SUB-04c | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "persist"` | ❌ W0 | ⬜ pending |
| 28-01-04 | 01 | 1 | SUB-04d | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "atomic"` | ❌ W0 | ⬜ pending |
| 28-01-05 | 01 | 1 | SUB-04e | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "create"` | ❌ W0 | ⬜ pending |
| 28-01-06 | 01 | 1 | SUB-04f | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "read"` | ❌ W0 | ⬜ pending |
| 28-01-07 | 01 | 1 | SUB-04g | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "list"` | ❌ W0 | ⬜ pending |
| 28-01-08 | 01 | 1 | SUB-04h | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "delete"` | ❌ W0 | ⬜ pending |
| 28-01-09 | 01 | 1 | SUB-04i | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "missing"` | ❌ W0 | ⬜ pending |
| 28-01-10 | 01 | 1 | SUB-04j | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "directory"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/store/__tests__/subscription-store.test.ts` — test stubs for all SUB-04 sub-requirements
- [ ] `src/schemas/subscription.ts` — schema file (must exist before tests run)

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
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
