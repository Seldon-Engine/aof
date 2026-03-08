---
phase: 27
slug: trace-cli
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-07
---

# Phase 27 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^3.0.0 |
| **Config file** | vitest.config.ts (root) |
| **Quick run command** | `npx vitest run src/trace/__tests__/ src/cli/commands/__tests__/ --reporter=verbose` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/trace/__tests__/ --reporter=verbose`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 27-01-01 | 01 | 1 | PRES-01 | unit | `npx vitest run src/trace/__tests__/trace-reader.test.ts src/trace/__tests__/trace-formatter.test.ts -x` | ❌ W0 | ⬜ pending |
| 27-01-02 | 01 | 1 | PRES-02 | unit | `npx vitest run src/trace/__tests__/trace-formatter.test.ts -x` | ❌ W0 | ⬜ pending |
| 27-01-03 | 01 | 1 | PRES-03 | unit | `npx vitest run src/trace/__tests__/trace-formatter.test.ts -x` | ❌ W0 | ⬜ pending |
| 27-01-04 | 01 | 1 | PRES-04 | unit | `npx vitest run src/trace/__tests__/trace-formatter.test.ts -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/trace/__tests__/trace-reader.test.ts` — stubs for PRES-01 (reading trace files)
- [ ] `src/trace/__tests__/trace-formatter.test.ts` — stubs for PRES-01, PRES-02, PRES-03, PRES-04 (all formatting modes)
- [ ] `src/cli/commands/__tests__/trace.test.ts` — stubs for CLI integration (command registration, option parsing)

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
