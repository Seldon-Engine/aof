---
phase: 36
slug: config-registry
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 36 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3.x |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run src/config/__tests__/registry.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~50 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/config/__tests__/registry.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green + grep verification for CFG-03/CFG-04
- **Max feedback latency:** 50 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 36-01-01 | 01 | 1 | CFG-01 | unit | `npx vitest run src/config/__tests__/registry.test.ts -t "validation"` | ❌ W0 | ⬜ pending |
| 36-01-02 | 01 | 1 | CFG-02 | unit | `npx vitest run src/config/__tests__/registry.test.ts -t "reset"` | ❌ W0 | ⬜ pending |
| 36-01-03 | 01 | 1 | CFG-04 | smoke | `grep -r "from.*dispatch\|from.*service\|from.*store" src/config/registry.ts` | ✅ | ⬜ pending |
| 36-02-01 | 02 | 1 | CFG-03 | smoke | `grep -r "process.env" src/ --include="*.ts" \| grep -v __tests__ \| grep -v config/ \| grep -v callback-delivery \| grep -v shared.ts` | ✅ | ⬜ pending |
| 36-02-02 | 02 | 1 | CFG-03 | regression | `npm test` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/config/__tests__/registry.test.ts` — stubs for CFG-01 (validation, frozen object, ConfigError) and CFG-02 (resetConfig with overrides, test isolation)
- [ ] Rename `src/config/__tests__/manager.test.ts` → `src/config/__tests__/org-chart-config.test.ts`

*Existing infrastructure covers CFG-03 (grep check) and CFG-04 (grep check).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Unknown AOF_* var typo warning | CFG-01 | Requires setting unknown env vars | Set `AOF_DAAT_DIR=x`, call getConfig(), verify warning output |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 50s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
