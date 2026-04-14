---
phase: 42
slug: installer-mode-exclusivity
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-14
---

# Phase 42 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3.x |
| **Config file** | `tests/integration/vitest.config.ts` (existing) for the new integration test file; `vitest.config.ts` (root) for the `service-file.test.ts` unit extension |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm run test:all` |
| **Estimated runtime** | ~10s unit; +30–60s for the new installer integration test (tarball build + shell-out) |

---

## Sampling Rate

- **After every task commit:** Run `npm test` (unit suite, ~10s) — catches `service-file.test.ts` regressions.
- **After every plan wave:** Run `npm run test:integration:plugin` (adds the new installer integration file; requires staged tarball).
- **Before `/gsd-verify-work`:** `npm run test:all` must be green, plus a clean `npm run build && node scripts/build-tarball.mjs 0.0.0-test && npx vitest run tests/integration/install-mode-exclusivity.test.ts`.
- **Max feedback latency:** ~10s at the task level; ~90s at the wave level.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 42-0-01 | 0 | 0 | D-01,D-03,D-04,D-05 | — | N/A | integration harness scaffold | `npx vitest run tests/integration/install-mode-exclusivity.test.ts` | ❌ W0 | ⬜ pending |
| 42-0-02 | 0 | 0 | D-05 | T-42-01 | `uninstallService` idempotent; quoted path expansions | unit | `npx vitest run src/daemon/__tests__/service-file.test.ts` | ✅ (extend) | ⬜ pending |
| 42-1-01 | 1 | 1 | D-01 | T-42-02 | Quoted `$OPENCLAW_HOME` in detection | unit+integration | `npx vitest run tests/integration/install-mode-exclusivity.test.ts -t "detection"` | ❌ W0 | ⬜ pending |
| 42-1-02 | 1 | 1 | D-03 | — | No daemon plist created when plugin-mode detected | integration | `npx vitest run tests/integration/install-mode-exclusivity.test.ts -t "fresh install"` | ❌ W0 | ⬜ pending |
| 42-1-03 | 1 | 1 | — | — | Pure-standalone regression unchanged | integration | `npx vitest run tests/integration/install-mode-exclusivity.test.ts -t "standalone"` | ❌ W0 | ⬜ pending |
| 42-2-01 | 2 | 2 | D-04 | T-42-02 | `--force-daemon` documented in help, quoted args | integration | `npx vitest run tests/integration/install-mode-exclusivity.test.ts -t "force-daemon"` | ❌ W0 | ⬜ pending |
| 42-2-02 | 2 | 2 | D-04 | — | `--help` surfaces flag | unit | `npx vitest run tests/integration/install-mode-exclusivity.test.ts -t "help"` | ❌ W0 | ⬜ pending |
| 42-3-01 | 3 | 3 | D-05 | T-42-01 | Redundant daemon removed, orphan sock/pid cleaned | integration | `npx vitest run tests/integration/install-mode-exclusivity.test.ts -t "upgrade"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*Task IDs are placeholders — final IDs assigned by gsd-planner during PLAN.md creation.*

---

## Wave 0 Requirements

- [ ] `tests/integration/install-mode-exclusivity.test.ts` — new file: covers D-01 detection, D-03 skip, D-04 override, D-05 upgrade convergence, pure-standalone regression, `--help` inclusion. Shell-out via `execFileSync("sh", ["install.sh", "--tarball", ...])` with `HOME` / `OPENCLAW_HOME` sandboxed.
- [ ] `src/daemon/__tests__/service-file.test.ts` — extend with `uninstallService()` idempotency tests (mock `execSync`, verify no-throw on double-call, verify swallowed `launchctl bootout` failures). No existing uninstall coverage — verified.
- [ ] Tarball fixture strategy — PLAN.md decides: on-demand build in `beforeAll` vs. CI-produced `.release-staging/*.tar.gz` consumed as fixture.

*Framework already installed — Vitest 3.x is in `package.json`. No new framework work.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real-launchd daemon unload on a developer's actual Mac | D-05 | Fake-home sandbox can't register with real `launchctl bootstrap`; integration test only verifies file-level removal | On a Mac with both plugin + daemon pre-installed: run the new installer, confirm `launchctl list | grep ai.openclaw.aof` returns empty, `~/Library/LaunchAgents/ai.openclaw.aof.plist` absent, no running `aof-daemon` PID. |
| `curl \| sh` non-interactive end-to-end | D-03 | Tarball must be uploaded to release artifact host first | After release cut, run `curl -fsSL <release-url>/install.sh \| sh` on a clean VM with `~/.openclaw/extensions/aof` symlink present; confirm skip message and `exit 0`. |
| Linux (systemd) path | — | CI matrix coverage uncertain; integration test is macOS-biased for launchd | If Linux is supported by this phase's scope, smoke-test `install.sh` on a Linux host with and without the symlink; document result. Planner must decide whether to skip on non-darwin or extend. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (`install-mode-exclusivity.test.ts`, `service-file.test.ts` uninstall coverage)
- [ ] No watch-mode flags in commands
- [ ] Feedback latency < 90s at wave level
- [ ] `nyquist_compliant: true` set in frontmatter after planner assigns final task IDs

**Approval:** pending
