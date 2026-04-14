---
phase: 42-installer-mode-exclusivity
plan: 03
subsystem: infra
tags: [installer, shell, posix, cli-flags, mode-exclusivity, force-daemon]

# Dependency graph
requires:
  - phase: 42-installer-mode-exclusivity
    provides: plugin_mode_detected() helper + install_daemon skip-gate + 3-way print_summary branch (Plan 02)
provides:
  - FORCE_DAEMON global bool in scripts/install.sh (D-04 flag state)
  - parse_args --force-daemon case arm (D-04)
  - --help advertisement line for --force-daemon (D-04)
  - install_daemon override branch: plugin-mode + FORCE_DAEMON → warn + install
affects: [42-04-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "POSIX [ -z \"$FORCE_DAEMON\" ] / [ -n \"$FORCE_DAEMON\" ] quoted test for override gating"
    - "parse_args case-arm convention: adjacent placement of override flag next to its primary (--force-daemon next to --force)"
    - "install_daemon gate composition: Plan 02 added the initial gate; Plan 03 spliced an AND-clause + a fall-through warn branch"

key-files:
  created:
    - .planning/phases/42-installer-mode-exclusivity/42-03-SUMMARY.md
  modified:
    - scripts/install.sh

key-decisions:
  - "Kept the two gate conditions as two separate `if plugin_mode_detected && [ ... ]` clauses (skip + warn) rather than a single if/else. Reason: Plan 04 needs to splice a D-05 uninstall block into the skip branch, and keeping the two branches structurally symmetric (both guarded by `plugin_mode_detected && ...`) makes the Plan 04 edit a pure prepend inside the skip branch — no re-indenting of the warn branch."
  - "The override warn uses `warn` (yellow !) not `say` (green ✓). Rationale: `--force-daemon` produces a documented foot-gun (dual-polling), which is `warn` semantics per install.sh's help-string convention at L15-25."
  - "Did not touch `print_summary`: when FORCE_DAEMON=true and daemon install succeeds, DAEMON_INSTALLED=\"true\" gets set by the existing `node ... daemon install` path and Plan 02's three-way branch picks the 'installed and running' leg automatically. Confirmed by reading install.sh:748-754 (Plan 02 state) — `plugin_mode_detected && [ -z \"$DAEMON_INSTALLED\" ]` is the skip condition; FORCE_DAEMON bypasses it by ensuring DAEMON_INSTALLED becomes non-empty."

patterns-established:
  - "`FORCE_DAEMON` follows the existing bool-var convention: empty-string default, literal `\"true\"` when flag present"
  - "Override flag case-arms live immediately after their related primary flag in parse_args (--force-daemon after --force)"

requirements-completed: [D-04]

# Metrics
duration: 8min
completed: 2026-04-14
---

# Phase 42 Plan 03: --force-daemon Override Summary

**Adds `--force-daemon` override flag to scripts/install.sh (global + parse_args arm + --help line + install_daemon override branch), turning integration specs 4 (D-04 --force-daemon) and 5 (D-04 --help) GREEN while preserving Plan 02 regressions (specs 1 and 3) and leaving spec 2 RED for Plan 04.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-04-14T23:18:00Z (approx)
- **Completed:** 2026-04-14T23:23:00Z (approx)
- **Tasks:** 1 (single auto-TDD task bundling four surgical edits)
- **Files modified:** 1 (scripts/install.sh: +15 / -3)

## Accomplishments

- Added `FORCE_DAEMON=""` global (scripts/install.sh:45) adjacent to `FORCE_CLEAN=""` in the bool-flag block.
- Added `--force-daemon)` case arm in `parse_args` (scripts/install.sh:110-112) setting `FORCE_DAEMON="true"`, placed immediately after `--force)`.
- Extended the `--help` printf block with a 4-line `--force-daemon` description (scripts/install.sh:138-141), column-aligned with the existing `--force` entry and worded to flag the dual-polling foot-gun.
- Modified `install_daemon` (scripts/install.sh:683-693): the skip-gate now requires `&& [ -z "$FORCE_DAEMON" ]`, and a second `if plugin_mode_detected && [ -n "$FORCE_DAEMON" ]` branch emits the override warn `--force-daemon set: installing daemon despite plugin-mode detection. Dual-polling will occur.` before falling through to the existing install path.
- Integration specs 4 (D-04 --force-daemon) and 5 (D-04 --help) flipped RED → GREEN. Specs 1 (D-01/D-03 skip) and 3 (regression) remain GREEN. Spec 2 (D-05 upgrade) remains RED — Plan 04 owns it.

## Task Commits

1. **Task 1: Add FORCE_DAEMON global + flag + --help + override branch** — `c53e50d` (feat)

**Plan metadata commit:** to be made after SUMMARY.md + STATE.md + ROADMAP.md are staged.

## Files Modified

- `scripts/install.sh` (+15 lines, -3 lines) — the four surgical edits.

## Exact Line Numbers Edited in install.sh

| Edit | Location (post-commit) | Description |
|------|-----------------------|-------------|
| 1 | scripts/install.sh:45 | New `FORCE_DAEMON=""` global, inserted between `FORCE_CLEAN=""` (L44) and `LOCAL_TARBALL=""` (L46). |
| 2 | scripts/install.sh:110-112 | New `--force-daemon)` case arm in `parse_args`, inserted between `--force)` (L107-109) and `--tarball)` (L113). |
| 3 | scripts/install.sh:138-141 | New 4-line `--force-daemon` printf block in `--help`, inserted between the `--force` help lines (L136-137) and the `--tarball` help lines (L142-144). Column-aligned with `--force` entry. |
| 4 | scripts/install.sh:683-693 | `install_daemon` modified: (a) skip-gate condition now `plugin_mode_detected && [ -z "$FORCE_DAEMON" ]`; (b) new override branch `plugin_mode_detected && [ -n "$FORCE_DAEMON" ]` emits the warn and falls through to the unchanged install path. Comment updated to note Plan 04 still owns D-05. |

## Integration Spec Status After Plan 03

| Spec | Before Plan 03 | After Plan 03 | Owner if Still RED |
|------|---------------|---------------|--------------------|
| D-01/D-03: skips daemon install when plugin symlink is present | GREEN | **GREEN** (regression held) | — |
| regression: pure standalone (no symlink) still installs daemon | GREEN | **GREEN** (regression held) | — |
| D-04: --force-daemon installs even with plugin-mode detected | RED | **GREEN** | — |
| D-04: --help lists --force-daemon | RED | **GREEN** | — |
| D-05: removes pre-existing daemon on upgrade with plugin present | RED | RED (expected) | Plan 04 |

**Target state achieved:** 4/5 specs GREEN, 1/5 RED and reserved for Plan 04.

## Decisions Made

1. **Two separate `plugin_mode_detected && [ ... ]` branches instead of if/else.** Keeps the two branches structurally symmetric — Plan 04's D-05 uninstall shell-out prepends cleanly into the skip branch without re-indenting the warn branch. The if/else form would have forced Plan 04 into a deeper diff.
2. **`warn` (not `say`) for the override message.** `--force-daemon` is a documented foot-gun (the --help text explicitly warns about dual-polling). `warn`'s yellow `!` glyph telegraphs the footgun visually; `say`'s green `✓` would be miscommunication.
3. **No `print_summary` change needed.** Verified by reading scripts/install.sh:748-754 and :764-771 (Plan 02's three-way branches). With FORCE_DAEMON=true, the existing daemon-install path sets DAEMON_INSTALLED="true", which makes the three-way branches pick the "installed and running" leg automatically — no additional branching needed.
4. **Exact warn message string** — `--force-daemon set: installing daemon despite plugin-mode detection. Dual-polling will occur.` — chosen to match the integration spec 4 regex `/--force-daemon set/` while being informative to the user. Dot-and-period punctuation mirrors the skip-note style established in Plan 02.

## Deviations from Plan

None. Plan 03 executed exactly as written. All four edits landed at the predicted line numbers; all acceptance greps pass; both target specs flipped GREEN on first run; no regressions on Plan 02 specs.

## --clean Interaction Check (per PLAN.md §output + RESEARCH.md §Pitfall 3)

Confirmed by code inspection (not a full smoke test — integration suite doesn't exercise `--clean --force-daemon`):

- Running `install.sh --clean --force-daemon` with a plugin-mode setup would execute `remove_external_integration` FIRST (scripts/install.sh:915-943), which deletes the `$OPENCLAW_HOME/extensions/aof` symlink. By the time `install_daemon` runs, `plugin_mode_detected` returns 1 (no symlink), so neither new gate fires — the installer falls through to the unchanged existing install path regardless of `FORCE_DAEMON`.
- **Net effect:** `--clean --force-daemon` installs the daemon just like `--clean` alone would today, bypassing both the skip and override branches. This is semantically correct (the user asked for daemon install, they got it), but the override warn (`--force-daemon set: ...`) does NOT fire in this combined-flags path. RESEARCH.md §Pitfall 3 documents this as expected behavior, not a bug. Plan 03 does not attempt to preserve warn semantics across `--clean`.
- No documentation update needed — the `--help` text advertises `--force-daemon` as "install even when plugin-mode detected", which remains true in the `--clean` path (daemon installs because plugin-mode is no longer detected, but the outcome — daemon installed — matches the flag's contract).

## Fragile Files Check

- `git diff src/plugin.ts src/openclaw/adapter.ts src/daemon/daemon.ts src/daemon/service-file.ts` — empty. No fragile TS touched. Verified before commit.

## Test Verification

- **Pre-edit state:** specs 4 and 5 RED (confirmed by `tail -60` on Plan 02's final integration run observed in 42-02-SUMMARY.md).
- **Post-edit verification sequence (all on darwin, AOF_INTEGRATION=1):**
  - `bash -n scripts/install.sh` → exit 0
  - `sh -n scripts/install.sh` → exit 0 (POSIX conformance)
  - `-t "force-daemon"` → 1 passed, 3 skipped (spec 4 green)
  - `-t "help"` → 1 passed, 4 skipped (spec 5 green)
  - `-t "D-01/D-03"` → 1 passed, 4 skipped (spec 1 still green)
  - Full suite → 4 passed, 1 failed (spec 2 — expected RED, Plan 04 owns)
- **Unit suite (`npm test`):** 3047 passed, 1 failed (`src/views/__tests__/watcher.test.ts > ViewWatcher > file events > emits 'remove' event`), 18 skipped.

## Issues Encountered

### Pre-existing flake: watcher.test.ts (not caused by Plan 03)

- `src/views/__tests__/watcher.test.ts` failed under full `npm test` parallel load on one of the 14 tests (`emits 'remove' event when file is deleted`).
- Verified as pre-existing and unrelated by:
  1. `git stash` → `npm test -- src/views/__tests__/watcher.test.ts` → 14/14 passed on pristine main.
  2. `git stash pop` → `npm test -- src/views/__tests__/watcher.test.ts` → 14/14 passed with Plan 03 changes staged.
- Conclusion: fs-watcher timing flake under parallel Vitest load. Plan 03 only touches `scripts/install.sh` — no plausible causal path to a TypeScript fs-watcher unit test. Flagged as pre-existing in the phase retrospective.
- Not treated as a Plan 03 deviation per CLAUDE.md scope-boundary rule (unrelated pre-existing failure). Logged to `deferred-items.md` (if the phase maintains one) or to the Phase 42 retrospective.

### Leaked launchd registration from the regression spec (known Plan 02 issue)

- The regression spec ("pure standalone") installs the real daemon, which registers against `gui/$UID` domain. Plan 02's SUMMARY §Issues Encountered documented this; Plan 04 owns the proper sandboxed `launchctl` fix.
- **Post-test cleanup performed:** `launchctl remove ai.openclaw.aof; rm -f ~/Library/LaunchAgents/ai.openclaw.aof.plist` — no residual registration left on the developer's machine.

### Orphan vitest workers

- Per CLAUDE.md's orphan-worker guidance, killed stray `node (vitest N)` processes before and after the integration runs with `ps -eo pid,command | grep -E "node \(vitest" | grep -v grep | awk '{print $1}' | xargs -r kill -9`. No orphans found during this plan's execution (clean runs, no aborts / timeouts).

## User Setup Required

None. Installer-script change only — no user-facing config, no migration, no env var changes.

## Deferred Issues

None from Plan 03's own scope. Pre-existing watcher.test.ts flake (see §Issues Encountered) is pre-existing and out of scope per CLAUDE.md scope-boundary rule.

## Next Phase Readiness

- **Plan 04 (Wave 3) ready:** Has 1 RED spec to turn green (D-05: removes pre-existing daemon on upgrade with plugin present). Plan 04's edit target is the same `install_daemon` function this plan just modified — specifically the skip branch (scripts/install.sh:685-688). Plan 04 will prepend a D-05 uninstall shell-out into that branch. Plan 03's deliberate choice of keeping skip and warn as two separate `if` clauses (rather than if/else) makes Plan 04's edit a pure prepend, no re-indent of the warn branch.
- **Launchd leakage:** Plan 04 will likely want to land the sandboxed `afterEach` launchctl cleanup (flagged in Plan 02's next-phase-readiness notes) to make the regression spec safe to run without manual cleanup.
- **Blocker:** None.

## TDD Gate Compliance

Plan 03's task declared `tdd="true"`. Plan 01 scaffolded specs 4 and 5 as RED in commits `f9057f8`/`fc31411`. Plan 03's `c53e50d` is the GREEN commit turning them green. No new RED test was written in this plan — the RED infrastructure was already in place from Plan 01, and Plan 03 wrote only production code. This matches the phase's TDD chain where Plan 01 = RED-only, Plans 02-04 = GREEN transitions.

No REFACTOR commit was needed — the install.sh diff is already minimal (15/-3 lines).

## Self-Check: PASSED

- `test -f scripts/install.sh` → FOUND
- `grep -q 'FORCE_DAEMON=""' scripts/install.sh` → FOUND (line 45)
- `grep -q -- '--force-daemon)' scripts/install.sh` → FOUND (line 111)
- `grep -q 'FORCE_DAEMON="true"' scripts/install.sh` → FOUND (line 112)
- `grep -cE -- '--force-daemon' scripts/install.sh` → 4 (parse_args arm, help line, install_daemon comment, warn message) — exceeds "at least 2" criterion
- `grep -q '\[ -z "\$FORCE_DAEMON" \]' scripts/install.sh` → FOUND (line 685)
- `grep -q '\[ -n "\$FORCE_DAEMON" \]' scripts/install.sh` → FOUND (line 690)
- `grep -q "force-daemon set: installing daemon despite plugin-mode detection" scripts/install.sh` → FOUND (line 691)
- `bash -n scripts/install.sh` → exit 0
- `sh -n scripts/install.sh` → exit 0
- `git diff src/plugin.ts src/openclaw/adapter.ts src/daemon/daemon.ts src/daemon/service-file.ts` → empty
- `git log --oneline | grep c53e50d` → FOUND (feat(42-03): add --force-daemon override to installer)
- `AOF_INTEGRATION=1 npx vitest run ... -t "force-daemon"` → 1 passed, 3 skipped (spec 4 GREEN)
- `AOF_INTEGRATION=1 npx vitest run ... -t "help"` → 1 passed, 4 skipped (spec 5 GREEN)
- `AOF_INTEGRATION=1 npx vitest run ... -t "D-01/D-03"` → 1 passed, 4 skipped (spec 1 still GREEN, no regression)
- `AOF_INTEGRATION=1 npx vitest run ... install-mode-exclusivity.test.ts` (full) → 4 passed, 1 failed (spec 2 RED — expected, Plan 04 owns)
- `npm test` → 3047 passed, 1 failed (pre-existing watcher.test.ts flake — isolated retest passes), 18 skipped

---

*Phase: 42-installer-mode-exclusivity*
*Completed: 2026-04-14*
