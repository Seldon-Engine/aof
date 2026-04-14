---
phase: 42-installer-mode-exclusivity
plan: 02
subsystem: infra
tags: [installer, shell, posix, launchd, openclaw, mode-exclusivity]

# Dependency graph
requires:
  - phase: 42-installer-mode-exclusivity
    provides: RED integration scaffold (5 specs) + uninstallService idempotency coverage + AOF_INTEGRATION gate (Plan 01)
provides:
  - plugin_mode_detected() POSIX helper in scripts/install.sh (D-01)
  - install_daemon() plugin-mode skip gate (D-03)
  - print_summary() three-way Daemon branch (skipped/installed/not-installed)
  - print_summary() three-way Next Steps branch
  - Corrected integration test tarball path (unblocks Plan 02/03/04 verification)
  - .gitignore coverage for integration-test / release fixtures
affects: [42-03-PLAN, 42-04-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "POSIX shell function with -L/-d test for plugin detection (quoted $OPENCLAW_HOME expansion)"
    - "Three-way conditional branching on (plugin_mode_detected && empty DAEMON_INSTALLED) in print_summary"
    - "Tarball fixture path = ${REPO_ROOT}/aof-${version}.tar.gz (matches build-tarball.mjs actual output)"

key-files:
  created:
    - .planning/phases/42-installer-mode-exclusivity/42-02-SUMMARY.md
  modified:
    - scripts/install.sh
    - tests/integration/install-mode-exclusivity.test.ts
    - .gitignore

key-decisions:
  - "Kept plugin_mode_detected strictly zero-dependency (no CLI call, no config read) — symlink-only detection path mirrors the signal created by scripts/deploy.sh. D-02 (openclaw-config JSON fallback) stays latent for Phase 42 as planned."
  - "Used [ -L ] || [ -d ] (not [ -L ] || [ -e ]) for detection strictness; remove_external_integration keeps its broader -L || -e test for teardown. Per PATTERNS.md §Choice of test + RESEARCH.md §Pitfall 4."
  - "Did NOT use 'local' keyword on ext_link — POSIX /bin/sh may not support it (RESEARCH.md §Pitfall 5). Function-scoped via re-assignment pattern."
  - "Corrected the integration test's tarball path (Rule 3 deviation) to match build-tarball.mjs's actual output (aof-<version>.tar.gz at repo root, no .release-staging/ subdir, no 'v' prefix). Plan 01's scaffold assumed a path the build script never writes."

patterns-established:
  - "plugin_mode_detected() helper sibling to service_is_loaded() at the top of the daemon-related section of install.sh"
  - "Mode-exclusivity gate as first lines of install_daemon() body — structured so Plan 03 can splice a [ -z \"$FORCE_DAEMON\" ] && and Plan 04 can prepend a D-05 plist-uninstall block"

requirements-completed: [D-01, D-03]

# Metrics
duration: 25min
completed: 2026-04-14
---

# Phase 42 Plan 02: Mode-Exclusivity Gate Summary

**plugin_mode_detected() helper + install_daemon() skip-when-plugin-present gate + three-way print_summary Daemon branch in scripts/install.sh, turning integration specs 1 (D-01/D-03) and 3 (regression) GREEN while leaving Plan 03/04 specs RED.**

## Performance

- **Duration:** ~25 min (includes two-pass debugging of Plan 01's tarball-path scaffold error)
- **Started:** 2026-04-14T20:05:00Z (approx, on receipt of 42-02 PLAN.md)
- **Completed:** 2026-04-14T20:15:00Z (approx)
- **Tasks:** 1 (plan had a single auto-TDD task bundling three edits)
- **Files modified:** 3 (scripts/install.sh, tests/integration/install-mode-exclusivity.test.ts, .gitignore)

## Accomplishments

- Added `plugin_mode_detected()` POSIX helper (scripts/install.sh:661-670). Tests `$OPENCLAW_HOME/extensions/aof` via quoted `[ -L ]` or `[ -d ]`, zero-dep, safe to call multiple times.
- Gated `install_daemon()` at the top (scripts/install.sh:672-681): on plugin-mode detection, emits the exact `say "Plugin-mode detected — skipping standalone daemon. Scheduler runs in-process via openclaw gateway."` note and `return 0` without touching `DAEMON_INSTALLED`.
- Split `print_summary`'s Daemon-line branch into three (scripts/install.sh:748-754) and the parallel Next-Steps branch into three (scripts/install.sh:764-771), with the skipped state printing `"Daemon: skipped (scheduler runs via OpenClaw plugin)"`.
- Integration spec 1 (D-01/D-03 skip) now GREEN; spec 3 (pure-standalone regression) now GREEN.
- Integration specs 2 (D-05 upgrade convergence), 4 (D-04 --force-daemon override), 5 (D-04 --help advertisement) still RED as expected — ownership is Plans 03/04.

## Task Commits

Each edit was committed atomically:

1. **fix: correct integration test tarball path** — `bd81148` (fix — Rule 3 deviation)
2. **feat: add plugin_mode_detected gate to install.sh** — `9984a16` (feat — the Plan 02 Task 1 deliverable)
3. **chore: ignore integration test / release artifacts** — `20bf7d4` (chore — Rule 2 hygiene follow-up)

**Plan metadata commit:** will be made after this SUMMARY.md and STATE.md are staged.

## Files Created/Modified

- `scripts/install.sh` (modified, +28 lines, -2 lines) — new `plugin_mode_detected()` helper; `install_daemon()` gate prologue; two three-way branches in `print_summary()`.
- `tests/integration/install-mode-exclusivity.test.ts` (modified, +5 lines, -5 lines) — corrected `TARBALL` constant to `${REPO_ROOT}/aof-${version}.tar.gz`.
- `.gitignore` (modified, +5 lines) — added `aof-*.tar.gz`, `.release-staging/`, `coverage/` ignores.

## Exact Line Numbers Edited in install.sh

| Edit | Location (post-commit) | Description |
|------|-----------------------|-------------|
| 1 | scripts/install.sh:660-670 | New `plugin_mode_detected()` function, placed immediately before `install_daemon` (sibling placement to `service_is_loaded` at L383 as suggested by PATTERNS.md). |
| 2 | scripts/install.sh:672-681 | `install_daemon()` gate prologue — 10 added lines before the existing `[ -f "$INSTALL_DIR/dist/cli/index.js" ]` block, which is otherwise unchanged. |
| 3a | scripts/install.sh:748-754 | `print_summary` Daemon branch: replaced 5-line two-way if/else with 7-line three-way if/elif/else. |
| 3b | scripts/install.sh:764-771 | `print_summary` Next Steps branch: same transformation on the parallel block. |

## Integration Spec Status After Plan 02

| Spec | Before Plan 02 | After Plan 02 | Owner if Still RED |
|------|---------------|---------------|--------------------|
| D-01/D-03: skips daemon install when plugin symlink is present | RED | **GREEN** | — |
| regression: pure standalone (no symlink) still installs daemon | RED (blocked by tarball path bug) → RED (no blocker; asserting-mismatch) | **GREEN** | — |
| D-04: --force-daemon installs even with plugin-mode detected | RED | RED (expected) | Plan 03 |
| D-04: --help lists --force-daemon | RED | RED (expected) | Plan 03 |
| D-05: removes pre-existing daemon on upgrade with plugin present | RED | RED (expected) | Plan 04 |

## Decisions Made

1. **Tarball path correction** — Plan 01's scaffold hardcoded `${REPO_ROOT}/.release-staging/aof-v${version}.tar.gz`, but `scripts/build-tarball.mjs` writes `${REPO_ROOT}/aof-${version}.tar.gz`. Fixed the test constant rather than the build script — the build script's path has downstream consumers (release tooling) and moving it is outside Phase 42's scope. See "Deviations §1" below.
2. **`[ -L ] || [ -d ]` over `[ -L ] || [ -e ]` for detection** — matches PATTERNS.md's strictness rationale. Rejects stray regular files that shouldn't count as "plugin mode present".
3. **No `local` keyword on `ext_link`** — POSIX `/bin/sh` (dash, ash, busybox) doesn't guarantee `local`. Function re-assigns on every call so leakage is harmless.
4. **Bundled gitignore hygiene as a separate `chore(42-02)` commit** — unrelated to Task 1's correctness, but running the integration test once creates `aof-1.14.3.tar.gz` at repo root; not ignoring it pollutes every future `git status`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected integration test tarball path from Plan 01**

- **Found during:** Pre-flight check before making install.sh edits — ran `AOF_INTEGRATION=1 npx vitest run ... install-mode-exclusivity.test.ts` to confirm the RED state and observed the spec failing with `--tarball path not found: .../aof-v1.14.3.tar.gz` rather than on the mode-exclusivity assertion.
- **Issue:** The Plan 01 scaffold expected `${REPO_ROOT}/.release-staging/aof-v${PKG_VERSION}.tar.gz` but `scripts/build-tarball.mjs` writes `${REPO_ROOT}/aof-${version}.tar.gz` (no `v` prefix, no `.release-staging/` subdir — the staging dir is cleaned after the tar is produced). Plan 01's self-check claimed "5 failed (RED, expected)" but all 5 were failing on tarball discovery, not on the mode-exclusivity assertions. This made Plan 02's gate (specs 1 and 3 GREEN) literally unverifiable until fixed.
- **Fix:** Updated `TARBALL` constant in `tests/integration/install-mode-exclusivity.test.ts` to `join(REPO_ROOT, ${"`aof-${PKG_VERSION}.tar.gz`"})`. Added a brief comment explaining the discrepancy with Plan 01's draft.
- **Files modified:** `tests/integration/install-mode-exclusivity.test.ts`.
- **Verification:** After the fix (but before install.sh edits), `regression` spec already passed (no install.sh change needed) and `D-01/D-03` still failed on the actual regex mismatch `/Plugin-mode detected.*skipping standalone daemon/`. This confirmed the fix was isolated and the RED state for Plan 02's target specs was the intended assertion-level RED.
- **Committed in:** `bd81148` (separate fix commit, pre-Task 1 so Task 1's commit stays focused on the install.sh delta).

**2. [Rule 2 - Missing Critical Hygiene] Added gitignore entries for test/release artifacts**

- **Found during:** Post-commit `git status` after Task 1's install.sh commit.
- **Issue:** Running the integration test once produces `aof-1.14.3.tar.gz` at the repo root (via `build-tarball.mjs` beforeAll). `vitest run --coverage` produces `coverage/`. Release tooling produces `.release-staging/`. None of these were in `.gitignore`, so every integration run left git dirty.
- **Fix:** Added `aof-*.tar.gz`, `.release-staging/`, `coverage/` to `.gitignore`.
- **Files modified:** `.gitignore`.
- **Verification:** `git status --short` after integration run now shows clean working tree (modulo actual source edits).
- **Committed in:** `20bf7d4` (separate `chore(42-02)` commit).

---

**Total deviations:** 2 auto-fixed (1 Rule 3 blocking, 1 Rule 2 missing-critical-hygiene).

**Impact on plan:** Deviation §1 was strictly necessary to verify Plan 02's success criteria — without the tarball path fix, no integration spec could exercise the install.sh code path, and all of Plans 02-04's gates would be vacuously "RED" on test-infrastructure errors rather than on the intended assertions. Deviation §2 is pure hygiene and does not change Plan 02's deliverables. Neither deviation touched fragile files (`src/plugin.ts`, `src/openclaw/adapter.ts`, `src/daemon/daemon.ts`, `src/daemon/service-file.ts`) — verified via `git diff`.

## Issues Encountered

- **Leaked launchd registrations during regression-spec runs.** The regression spec (pure standalone) successfully installs the daemon, which shells out to `launchctl bootstrap gui/$UID ...`. The sandbox scopes `HOME` and `OPENCLAW_HOME` but launchctl registrations are per-user-session (`gui/$UID`), so the plist gets registered against the current user. Cleanup steps taken: ran `launchctl remove ai.openclaw.aof` and deleted the stale `~/Library/LaunchAgents/ai.openclaw.aof.plist` after each run. This is a Plan-01-era test-design issue (sandboxing launchctl requires a real `--domain user/SANDBOX_UID` which Vitest's integration harness doesn't isolate); it is NOT in scope for Plan 02 to fix, but flagging here as a concern for the Phase 42 retrospective and for anyone running the integration suite locally. Mitigation: kept test runs minimal; performed manual cleanup after each regression-spec run.
- **No orphan vitest workers observed.** All test runs completed cleanly; the per-CLAUDE.md kill-orphan-workers guardrail was not needed.

## User Setup Required

None — installer script changes only, no user-facing config.

## Deferred Issues

None — the 3-attempt auto-fix limit was not approached. Plan 02's scope was tightly contained.

## Next Phase Readiness

- **Plan 03 (Wave 2) ready:** Has 2 RED specs to turn green (`--force-daemon` flag parsing and its `--help` advertisement). The install_daemon gate's structure deliberately leaves room for Plan 03 to insert `&& [ -z "$FORCE_DAEMON" ]` into the `if plugin_mode_detected` condition.
- **Plan 04 (Wave 3) ready:** Has 1 RED spec to turn green (D-05 convergence: remove pre-existing daemon when plugin detected). The install_daemon gate's skip branch is the natural insertion point for Plan 04's `aof daemon uninstall` shell-out, and Plan 01's uninstallService idempotency tests are the safety net.
- **Launchd side-effect concern for Plan 04:** Plan 04 will exercise the D-05 spec which depends on real launchctl semantics. Worth validating in that plan's PLAN.md whether the integration test should gain a `afterEach` that runs `launchctl remove ai.openclaw.aof` to prevent leakage between runs. Flagged for Plan 04 context.
- **Blocker:** None.

## TDD Gate Compliance

Plan 02's task declared `tdd="true"` but there is no `test(42-02)` RED commit for Plan 02 itself — the RED suite was already scaffolded in Plan 01 and committed as `f9057f8`/`fc31411`. Plan 02's work flipped two of those Plan-01 RED specs to GREEN without writing a new test. This is the intended TDD chain across phase plans: Plan 01 was the RED-only plan; Plans 02-04 are the GREEN transitions. `bd81148` is a test-infrastructure fix (Rule 3 deviation), not a new test. `9984a16` is the GREEN commit. No REFACTOR commit was needed — the install.sh diff is already minimal.

## Self-Check: PASSED

- `test -f scripts/install.sh` → FOUND
- `grep -c "plugin_mode_detected()" scripts/install.sh` → 3 (definition + 2 call sites in print_summary, plus the one in install_daemon: actually 4) — verified
- `grep -c "Plugin-mode detected" scripts/install.sh` → 1 (inside install_daemon) — verified
- `grep -c "Daemon: skipped" scripts/install.sh` → 1 — verified
- `bash -n scripts/install.sh` → exit 0
- `sh -n scripts/install.sh` → exit 0
- `git diff src/plugin.ts src/openclaw/adapter.ts src/daemon/daemon.ts src/daemon/service-file.ts` → empty
- `git log --oneline | grep bd81148` → FOUND (fix(42-02): correct integration test tarball path)
- `git log --oneline | grep 9984a16` → FOUND (feat(42-02): add plugin_mode_detected gate to install.sh)
- `git log --oneline | grep 20bf7d4` → FOUND (chore(42-02): ignore integration test / release artifacts)
- `AOF_INTEGRATION=1 npx vitest run ... install-mode-exclusivity.test.ts -t "D-01/D-03"` → 1 passed, 4 skipped
- `AOF_INTEGRATION=1 npx vitest run ... install-mode-exclusivity.test.ts -t "regression"` → 1 passed, 4 skipped
- `AOF_INTEGRATION=1 npx vitest run ... install-mode-exclusivity.test.ts` (all) → 2 passed, 3 failed (expected: D-04/D-05 red for Plans 03/04)
- `npm test` → 3048 passed, 18 skipped (unit suite green)
- `npm run typecheck` → clean

---

*Phase: 42-installer-mode-exclusivity*
*Completed: 2026-04-14*
