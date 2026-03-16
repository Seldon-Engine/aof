---
phase: 37
slug: structured-logging
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 37 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.x |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run src/logging/` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/logging/`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 37-01-01 | 01 | 1 | LOG-01, LOG-02, LOG-03 | unit | `npx vitest run src/logging/__tests__/logger.test.ts` | ❌ W0 | ⬜ pending |
| 37-01-02 | 01 | 1 | LOG-01 | unit | `npx vitest run src/logging/__tests__/logger.test.ts` | ❌ W0 | ⬜ pending |
| 37-02-01 | 02 | 2 | LOG-04, LOG-05 | smoke | `grep -rn "console\." src/dispatch src/daemon src/service src/protocol --include="*.ts" --exclude-dir=__tests__` | Manual grep | ⬜ pending |
| 37-02-02 | 02 | 2 | LOG-04 | smoke | `grep -rn "console\." src/mcp src/openclaw src/murmur src/plugins --include="*.ts" --exclude-dir=__tests__` | Manual grep | ⬜ pending |
| 37-XX-XX | XX | X | LOG-06 | smoke | `grep -c "console\." src/cli/index.ts` still nonzero | Manual | ⬜ pending |
| 37-XX-XX | XX | X | LOG-07 | smoke | `git diff src/events/` shows no changes | Manual | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/logging/__tests__/logger.test.ts` — stubs for LOG-01, LOG-02, LOG-03
- [ ] `src/logging/index.ts` — the logger factory module itself
- [ ] Install pino: `npm install pino`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CLI console.* output unchanged | LOG-06 | grep check, not unit testable | Run `aof status`, verify human-readable output |
| EventLogger unchanged | LOG-07 | Absence-of-change verification | `git diff src/events/` shows no changes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
