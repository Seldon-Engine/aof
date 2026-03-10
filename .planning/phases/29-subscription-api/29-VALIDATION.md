---
phase: 29
slug: subscription-api
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 29 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^3.0.0 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run src/mcp/__tests__/tools.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/mcp/__tests__/tools.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 29-01-01 | 01 | 1 | SUB-02, SUB-03 | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "subscribe\|unsubscribe"` | ❌ W0 | ⬜ pending |
| 29-01-02 | 01 | 1 | SUB-01 | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "dispatch.*subscribe"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] New test cases in `src/mcp/__tests__/tools.test.ts` — stubs for SUB-01, SUB-02, SUB-03
- [ ] Update `beforeEach` in tools.test.ts to include SubscriptionStore in AofMcpContext

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
