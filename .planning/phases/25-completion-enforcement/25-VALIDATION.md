---
phase: 25
slug: completion-enforcement
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-07
---

# Phase 25 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (via `scripts/test-lock.sh run`) |
| **Config file** | `vitest.config.ts` (root) + `tests/integration/vitest.config.ts` |
| **Quick run command** | `npx vitest run src/dispatch/__tests__/ --reporter=verbose` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/dispatch/__tests__/ --reporter=verbose`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 25-01-01 | 01 | 0 | ENFC-01 | unit | `npx vitest run src/dispatch/__tests__/completion-enforcement.test.ts -x` | W0 | pending |
| 25-01-02 | 01 | 0 | ENFC-01 | unit | `npx vitest run src/dispatch/__tests__/dag-completion-enforcement.test.ts -x` | W0 | pending |
| 25-01-03 | 01 | 0 | GUID-02 | unit | `npx vitest run src/openclaw/__tests__/executor.test.ts -x` | Existing (extend) | pending |
| 25-02-01 | 02 | 1 | ENFC-01 | unit | `npx vitest run src/dispatch/__tests__/completion-enforcement.test.ts -x` | W0 | pending |
| 25-02-02 | 02 | 1 | ENFC-04 | unit | `npx vitest run src/dispatch/__tests__/completion-enforcement.test.ts -x` | W0 | pending |
| 25-03-01 | 03 | 1 | ENFC-01 | unit | `npx vitest run src/dispatch/__tests__/dag-completion-enforcement.test.ts -x` | W0 | pending |
| 25-04-01 | 04 | 2 | GUID-01 | unit | `npx vitest run src/context/__tests__/context-budget-gate.test.ts -x` | Existing | pending |
| 25-04-02 | 04 | 2 | GUID-02 | unit | `npx vitest run src/openclaw/__tests__/executor.test.ts -x` | Existing (extend) | pending |
| 25-05-01 | 05 | 2 | ENFC-04 | unit | `npx vitest run src/schemas/__tests__/golden-fixture.test.ts -x` | Existing (update fixture) | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `src/dispatch/__tests__/completion-enforcement.test.ts` — stubs for ENFC-01 (top-level) + ENFC-04
- [ ] `src/dispatch/__tests__/dag-completion-enforcement.test.ts` — stubs for ENFC-01 (DAG path)
- [ ] Extend `src/openclaw/__tests__/executor.test.ts` — stubs for GUID-02 (enhanced instruction text)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SKILL.md readability for agents | GUID-01 | Subjective quality | Read SKILL.md completion section, verify it's clear and under ~50 tokens |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
