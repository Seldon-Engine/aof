---
phase: 42-installer-mode-exclusivity
plan: 01
subsystem: testing
tags: [vitest, tdd, installer, shell-integration, launchd, idempotency]

# Dependency graph
requires:
  - phase: 42-installer-mode-exclusivity
    provides: Phase 42 context, research, patterns, validation strategy
provides:
  - Red integration harness for install.sh mode-exclusivity (5 specs gated by AOF_INTEGRATION=1)
  - uninstallService idempotency coverage (3 green specs) closing T-42-01
  - vi.doMock pattern for node:child_process + node:fs mocking in service-file tests
  - AOF_INTEGRATION=1 opt-in flag for heavy integration tests that share the root vitest include glob
affects: [42-02-PLAN, 42-03-PLAN, 42-04-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "vi.doMock + vi.resetModules + dynamic import for per-test node:* mocking"
    - "AOF_INTEGRATION=1 gate for shell-integration tests under shared include glob"
    - "On-demand tarball fixture build via scripts/build-tarball.mjs in beforeAll"

key-files:
  created:
    - tests/integration/install-mode-exclusivity.test.ts
  modified:
    - src/daemon/__tests__/service-file.test.ts
    - package.json

key-decisions:
  - "Tarball fixture strategy: on-demand beforeAll build, gated by existsSync(TARBALL). Version pulled from package.json to satisfy build-tarball.mjs coherence check."
  - "uninstallService mocking: vi.doMock('node:child_process') + vi.doMock('node:fs') inside each it(), no production refactor of uninstallService to accept ops"
  - "AOF_INTEGRATION=1 env gate: keeps npm test green on darwin while test:integration:plugin exercises the RED suite"

patterns-established:
  - "RED-first test scaffolding: all 5 integration specs fail at commit time; Plans 02-04 turn them green"
  - "Platform + opt-in guard: describe.skipIf(platform !== 'darwin' || env !== '1') keeps suite runnable only under explicit integration CI"

requirements-completed: [D-01, D-03, D-04, D-05]

# Metrics
duration: 8min
completed: 2026-04-14
---

# Phase 42 Plan 01: Wave 0 RED Scaffold Summary

**RED integration harness (5 specs) for install.sh mode-exclusivity plus green uninstallService idempotency coverage (3 specs, T-42-01 mitigation), both committed atomically with production code untouched.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-04-14T19:53:00Z (approx)
- **Completed:** 2026-04-14T20:02:04Z
- **Tasks:** 2
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- Created `tests/integration/install-mode-exclusivity.test.ts` with 5 specs covering D-01/D-03 skip, D-04 --force-daemon override, D-04 --help advertisement, D-05 upgrade convergence, and pure-standalone regression. All 5 FAIL under `AOF_INTEGRATION=1` on darwin (expected RED state — Plans 02/03/04 turn them green).
- Extended `src/daemon/__tests__/service-file.test.ts` with `uninstallService idempotency` describe block (3 specs). All PASS on first run because `uninstallService` is already try/catch-guarded. Mitigates threat T-42-01 by closing the prior zero-coverage gap on the D-05 convergence step.
- Added `AOF_INTEGRATION=1` opt-in flag to `npm run test:integration:plugin`, keeping `npm test` green (3048 passed, 18 skipped) on darwin while letting integration runs exercise the RED suite.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create failing install-mode-exclusivity integration test** — `f9057f8` (test)
2. **Task 2: Extend service-file.test.ts with uninstallService idempotency** — `fc31411` (test)

_Note: Task 2's commit also carries the AOF_INTEGRATION env-gate change in package.json and the corresponding describe.skipIf tweak — see "Deviations from Plan" §1 below._

## Files Created/Modified

- `tests/integration/install-mode-exclusivity.test.ts` (NEW, 187 lines) — 5 RED specs + on-demand tarball build in beforeAll + sandboxed $HOME/$OPENCLAW_HOME.
- `src/daemon/__tests__/service-file.test.ts` (modified, +137 lines) — new `uninstallService idempotency` describe block (3 specs) using `vi.doMock` for node:child_process + node:fs.
- `package.json` (modified, 1 line) — added `AOF_INTEGRATION=1` env to the `test:integration:plugin` script.

## Decisions Made

1. **Tarball version = package.json version** (not the hardcoded `0.0.0-test` from PATTERNS.md §Template). Rationale: `scripts/build-tarball.mjs` has a version-coherence check that rejects mismatches between the tarball arg and the on-disk `package.json`/`openclaw.plugin.json` values. Pulling the version at test-load time keeps the fixture build deterministic without touching the shared build script.
2. **vi.doMock + dynamic import over module-level vi.mock.** Rationale: `vi.mock` hoists to the top of the file and applies globally, polluting other describe blocks in the same file. Per-test `vi.doMock` + `vi.resetModules` + `await import("../service-file.js")` scopes mocks to the single spec, matching the precedent in the `launchctlInstallIdempotent` block that ops-injects rather than monkey-patching fs/child_process globally.
3. **AOF_INTEGRATION=1 env gate** (see Deviations §1).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Gated integration describe on AOF_INTEGRATION=1 to keep `npm test` green**

- **Found during:** Task 1 verification (running `npm test` after committing the integration file).
- **Issue:** The PLAN's must_haves state `npm test` remains green, and VALIDATION.md claims `npm test → unit suite (excludes tests/integration by root vitest.config.ts)`. This is factually incorrect — the root `vitest.config.ts` include glob is `["src/**/__tests__/**/*.test.ts", "tests/**/*.test.ts"]`, which picks up `tests/integration/**`. Existing integration tests cope by using `describe.skip` unconditionally (plugin-load.test.ts) or by running entirely in-process (dispatch-pipeline.test.ts). Our new test does shell-out and must be RED under the integration config but NOT under `npm test`.
- **Fix:** Added `AOF_INTEGRATION=1` env to the `test:integration:plugin` npm script and changed the top-level `describe.skipIf(process.platform !== "darwin")` to `describe.skipIf(!(darwin && AOF_INTEGRATION==="1"))`. `npm test` now skips the suite entirely (5 skipped, 0 failed); `npm run test:integration:plugin` runs it and produces the intended 5 RED specs.
- **Files modified:** `package.json`, `tests/integration/install-mode-exclusivity.test.ts`.
- **Verification:** `npm test` exits 0 with 3048 passed / 18 skipped; `AOF_INTEGRATION=1 npx vitest run --config tests/integration/vitest.config.ts tests/integration/install-mode-exclusivity.test.ts` exits non-zero with 5 failed.
- **Committed in:** `fc31411` (bundled with Task 2 because the env flag unblocks Task 2's acceptance criterion that `npm test` stays green).

**2. [Rule 3 - Blocking] Tarball version pulled from package.json instead of `0.0.0-test`**

- **Found during:** Task 1 first run (beforeAll failed with "Version mismatch — tarball version 0.0.0-test does not match source files").
- **Issue:** PATTERNS.md §Template and PLAN.md §Tarball fixture strategy both hardcode `"0.0.0-test"` as the `build-tarball.mjs` argument. That script has a coherence gate (added at some point during v1.x hardening) that rejects any version arg that doesn't match `package.json.version` (currently `1.14.3`) — the gate exists to catch release-it `--no-npm` skips.
- **Fix:** Read `package.json.version` at test-load time, compute `TARBALL = .release-staging/aof-v${PKG_VERSION}.tar.gz`, pass `PKG_VERSION` as the build-tarball.mjs arg. Sandbox $HOME scoping still makes this a purely local/test fixture — no real launchd registration occurs.
- **Files modified:** `tests/integration/install-mode-exclusivity.test.ts`.
- **Verification:** Under `AOF_INTEGRATION=1`, the 5 specs now fail on the expected stdout-regex mismatches (not on tarball build errors) — the correct RED state.
- **Committed in:** `f9057f8` (Task 1 commit).

---

**Total deviations:** 2 auto-fixed (2 blocking issues)

**Impact on plan:** Both fixes were infrastructure-gating — without them the plan's success criteria (`npm test` green, 5 specs RED under integration config) were literally unachievable. Neither fix expands scope: Deviation §1 only moves the skip predicate, Deviation §2 only changes a string literal. Plans 02–04 remain unaffected — they still own the green transitions on each spec.

## Wave 0 → Wave 1+ Spec Ownership

| Spec | Status Today | Plan That Turns It Green |
|------|--------------|--------------------------|
| D-01/D-03: skips daemon install when plugin symlink is present | RED | **Plan 02** (add `plugin_mode_detected` + skip branch in `install_daemon`) |
| regression: pure standalone (no symlink) still installs daemon | RED (due to incidental Daemon: skipped print collision; Plan 02 installs the three-way summary branch) | **Plan 02** |
| D-04: --force-daemon installs even with plugin-mode detected | RED | **Plan 03** (add `--force-daemon` flag + override branch) |
| D-04: --help lists --force-daemon | RED | **Plan 03** (add `--force-daemon` line to `--help` printf block) |
| D-05: removes pre-existing daemon on upgrade with plugin present | RED | **Plan 04** (add the D-05 `daemon uninstall` shell-out in `install_daemon`'s plugin-mode branch) |

## Red Spec Count

**5 RED** under `AOF_INTEGRATION=1 npx vitest run --config tests/integration/vitest.config.ts tests/integration/install-mode-exclusivity.test.ts` on darwin. **0 RED** under `npm test` (5 skipped). This is the intended TDD gate.

## Issues Encountered

- **Pre-commit hook timing:** `npm run docs:generate` pre-commit hook runs cleanly — no docs regenerated because this plan touches zero CLI surface.
- **Orphan vitest workers:** None observed this run; no aborted/timed-out test runs occurred.

## User Setup Required

None. Test-only changes.

## Next Phase Readiness

- **Plan 02 (Wave 1):** Ready. Has 3 RED specs to turn green (D-01/D-03 skip + regression branch in `print_summary`). Must edit `scripts/install.sh` only; `src/daemon/service-file.ts` stays untouched per CLAUDE.md fragile-gate.
- **Plan 03 (Wave 2):** Ready. Has 2 RED specs to turn green (`--force-daemon` flag parsing + `--help`).
- **Plan 04 (Wave 3):** Ready. Has 1 RED spec to turn green (D-05 upgrade convergence). Plan 01's `uninstallService idempotency` tests are the safety net for this D-05 path.
- **Blocker:** None.

## Self-Check: PASSED

- `test -f tests/integration/install-mode-exclusivity.test.ts` → FOUND
- `git log --oneline | grep f9057f8` → FOUND (test(42-01): add RED integration scaffold...)
- `git log --oneline | grep fc31411` → FOUND (test(42-01): add uninstallService idempotency coverage)
- `git diff HEAD~2 HEAD -- src/daemon/service-file.ts scripts/install.sh` → empty (production code untouched — verified)
- `npx vitest run src/daemon/__tests__/service-file.test.ts -t "uninstallService idempotency"` → 3 passed
- `AOF_INTEGRATION=1 npx vitest run --config tests/integration/vitest.config.ts tests/integration/install-mode-exclusivity.test.ts` → 5 failed (RED, expected)
- `npm test` → 3048 passed, 18 skipped (green)

---

*Phase: 42-installer-mode-exclusivity*
*Completed: 2026-04-14*
