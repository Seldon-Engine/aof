---
phase: 39
slug: architecture-fixes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 39 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.2.4 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run` + `npx madge --circular --extensions ts src/`
- **After every plan wave:** Run `npx vitest run` (full suite)
- **Before `/gsd:verify-work`:** Full suite must be green AND madge reports 0 cycles
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 39-XX-01 | 01 | 1 | ARCH-01 | smoke | `npx madge --circular --extensions ts src/` | N/A (CLI) | ⬜ pending |
| 39-XX-02 | 01 | 1 | ARCH-02 | smoke | `grep -r "serializeTask\|writeFileAtomic" src/ --include="*.ts" -l` (filtered to non-store) | N/A (grep) | ⬜ pending |
| 39-XX-03 | 01 | 1 | ARCH-03 | smoke | `grep -r "from.*org/" src/config/ --include="*.ts"` | N/A (grep) | ⬜ pending |
| 39-XX-04 | 01 | 1 | ARCH-04 | smoke | `grep -r "from.*cli/" src/mcp/ --include="*.ts"` | N/A (grep) | ⬜ pending |
| 39-XX-05 | 01 | 1 | ARCH-05 | smoke | `grep -rn "loadProjectManifest" src/ --include="*.ts"` (single impl) | N/A (grep) | ⬜ pending |
| 39-XX-06 | 01 | 1 | ARCH-06 | manual | Review memory/index.ts < 40 lines, no function defs | N/A | ⬜ pending |
| 39-XX-07 | ALL | ALL | ALL | regression | `npx vitest run` | Existing suite | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. This phase is structural refactoring validated by madge, grep, and existing test suite. No new test files needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| memory/index.ts is pure barrel | ARCH-06 | File length/content check | Verify < 40 lines, only re-exports, no function definitions |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
