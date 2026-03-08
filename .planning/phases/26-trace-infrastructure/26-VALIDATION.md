---
phase: 26
slug: trace-infrastructure
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-07
---

# Phase 26 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^3.0.0 |
| **Config file** | vitest.config.ts (root) |
| **Quick run command** | `npx vitest run src/trace/ --reporter=verbose` |
| **Full suite command** | `npx vitest run --reporter=verbose` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/trace/ --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --reporter=verbose`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 26-01-01 | 01 | 1 | TRAC-01 | unit | `npx vitest run src/trace/__tests__/session-parser.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-01-02 | 01 | 1 | TRAC-06 | unit | `npx vitest run src/trace/__tests__/session-parser.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-02-01 | 02 | 1 | TRAC-02 | unit | `npx vitest run src/trace/__tests__/trace-writer.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-02-02 | 02 | 1 | TRAC-03 | unit | `npx vitest run src/trace/__tests__/trace-writer.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-02-03 | 02 | 1 | TRAC-04 | unit | `npx vitest run src/trace/__tests__/trace-writer.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-02-04 | 02 | 1 | TRAC-05 | unit | `npx vitest run src/trace/__tests__/trace-writer.test.ts -x` | ❌ W0 | ⬜ pending |
| 26-03-01 | 03 | 2 | ENFC-03 | unit | `npx vitest run src/trace/__tests__/noop-detector.test.ts -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/trace/__tests__/session-parser.test.ts` — stubs for TRAC-01, TRAC-06
- [ ] `src/trace/__tests__/trace-writer.test.ts` — stubs for TRAC-02, TRAC-03, TRAC-04, TRAC-05
- [ ] `src/trace/__tests__/noop-detector.test.ts` — stubs for ENFC-03
- [ ] `tests/fixtures/session-*.jsonl` — test fixture files with known content for deterministic parsing tests
- [ ] `src/schemas/trace.ts` — Zod schema (tested via unit tests)

*Existing vitest infrastructure covers all framework requirements.*

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
