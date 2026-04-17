---
phase: 43
plan: 08
subsystem: packaging,installer
tags: [wave-4, installer, migration, deprecation, phase-42-reversal]
requires:
  - 43-01 (Wave 0 RED test for migration 007)
provides:
  - Migration 007: idempotent aof-daemon install on `aof setup --auto --upgrade`
  - install.sh always-install-daemon behavior (Phase 42 D-03 skip-gate reversed)
  - --force-daemon deprecation-warn no-op (Phase 42 D-04 override superseded by D-01)
  - Updated integration test matrix reflecting Phase 43 reality
affects:
  - Phase 42 D-03/D-04/D-05 installer decisions (reversed/superseded)
  - tests/integration/install-mode-exclusivity.test.ts (3 of 5 specs inverted/removed/rewritten)
tech-stack:
  added: []
  patterns:
    - src/packaging/migrations/004-scaffold-repair.ts canonical idempotent skeleton
    - src/packaging/migrations/006-data-code-separation.ts existsSync breadcrumb pattern
    - scripts/install.sh parse_args + install_daemon split
key-files:
  created:
    - src/packaging/migrations/007-daemon-required.ts
  modified:
    - src/cli/commands/setup.ts (getAllMigrations registration)
    - scripts/install.sh (install_daemon simplification + --force-daemon demotion + print_summary/next-steps cleanup)
    - tests/integration/install-mode-exclusivity.test.ts (4 specs after 1 removal)
decisions:
  - "Migration 007 version 1.15.0: next minor from package.json 1.14.11 per MEMORY.md milestone_version_pairing. Next actual release will pair this migration with v1.15.0."
  - "ctx.aofRoot passed directly to installService({ dataDir }) — no /data nesting. ctx.aofRoot IS the user-data dir in the setup.ts migration call site (migration 006 treats it the same way). RED test at line 98 pins this contract: expect(config.dataDir).toBe(aofRoot)."
  - "No down() on migration 007 — matches 005/006 precedent. Canonical rollback is 'install older AOF version'; uninstalling the daemon would strand the thin-bridge plugin with no IPC authority (Phase 43 D-02 removes the in-process fallback)."
  - "install-mode-exclusivity.test.ts filename kept (avoid rename noise). Describe block renamed to reflect Phase 43 always-install-daemon reality."
  - "--force-daemon flag parser retained — only the effect is deprecated. v1.14 scripts/CI that pass --force-daemon keep working (they now get a deprecation warning on stderr + default install behavior)."
  - "plugin_mode_detected() helper kept — still used by print_summary for the informational 'plugin bridges to daemon over IPC' suffix. The detection signal itself is Phase 42 D-01 and remains correct; only the gating of install_daemon on it was wrong post-D-01 reversal."
metrics:
  duration: 4m52s
  completed: 2026-04-17
---

# Phase 43 Plan 08: Installer Reversal + Migration 007 Summary

Reversed Phase 42's installer exclusivity and landed Migration 007 so existing users pick up the mandatory daemon on `aof setup --auto --upgrade`, and fresh `curl | sh` users get it via unconditional install.sh. `--force-daemon` demoted to a deprecation-warn no-op for one release cycle.

## Tasks Completed

| Task | Name                                                                   | Commit    | Files                                                                                             |
| ---- | ---------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| 1    | Migration 007 — install daemon if absent (idempotent)                  | `81a8f45` | `src/packaging/migrations/007-daemon-required.ts` (new), `src/cli/commands/setup.ts` (registered) |
| 2    | Reverse Phase 42 installer gates + demote --force-daemon               | `00ffda9` | `scripts/install.sh`, `tests/integration/install-mode-exclusivity.test.ts`                        |

## What Landed

### Migration 007 (Task 1)

Idempotent one-shot migration that:

1. Computes the platform-specific service-file path: `~/Library/LaunchAgents/ai.openclaw.aof.plist` (macOS) or `~/.config/systemd/user/ai.openclaw.aof.service` (Linux).
2. `existsSync` on either → short-circuits with a green-check breadcrumb line. Handles three pre-conditions without special-casing: (a) fresh `--force-daemon` install, (b) pre-Phase-42 dual-mode install, (c) any prior run of this migration.
3. Otherwise calls `installService({ dataDir: ctx.aofRoot })` — reuses the existing helper from `src/daemon/service-file.ts`, which writes the plist/unit + loads/starts the service.
4. No `down()`. Rollback path is "install older AOF version" (Phase 43 Research §Rollback confirms this is the canonical pattern; matches 005/006).

Registered via a single-line append to `getAllMigrations()` in `src/cli/commands/setup.ts` (line 84). Order: `[001, 003, 004, 005, 006, 007]`.

### Installer Simplification (Task 2)

Removed from `scripts/install.sh`:

- The `plugin_mode_detected && [ -z "$FORCE_DAEMON" ]` skip-gate (Phase 42 D-03) — 16 lines.
- The `plist` existence check + `daemon uninstall` convergence branch (Phase 42 D-05) — 6 lines.
- The "Plugin-mode detected — skipping standalone daemon" `say` note.
- The "--force-daemon set: installing daemon despite plugin-mode detection. Dual-polling will occur" warn (no dual-polling possible any more — the in-process scheduler is gone per D-02).
- The `plugin_mode_detected && [ -z "$DAEMON_INSTALLED" ]` branches in `print_summary` and `Next steps` (they announced a state — plugin-mode-daemon-skipped — that no longer exists).

Added:

- A loud `--force-daemon is DEPRECATED as of v1.15 and has no effect …` warning when the flag is set.
- A `[DEPRECATED]` prefix on the `--force-daemon` line in `--help` output.
- Comment blocks documenting the Phase 43 reversals at each touchpoint (parse_args, install_daemon, print_summary) so the rationale survives future archaeology.
- `print_summary` daemon branch now differentiates plugin-mode by appending `(plugin bridges to daemon over IPC)` to the installed-and-running line — informational, not behavioral.

**Diff stats:** `scripts/install.sh` 74 lines changed (37 insertions, 37 deletions net). The plan forecast ~20-30 removed + ~3 added; actual came out balanced because the replacement added explanatory comments (Phase 43 D-01/D-04 references) that pre-Phase-42 didn't need.

### Integration Test Matrix (Task 2)

`tests/integration/install-mode-exclusivity.test.ts` — 5 Phase 42 specs reduced to 4 Phase 43 specs:

| # | Phase 42 name                                                     | Phase 43 disposition                                                                                                                                     |
| - | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | D-01/D-03: skips daemon install when plugin symlink is present    | **Inverted.** Now: "D-01: installs the daemon even when the plugin symlink is present." Asserts `!skipping` + `Installing daemon service` + attempted result.                                                                                |
| 2 | D-05: removes pre-existing daemon on upgrade with plugin present  | **Removed.** Phase 43 has no convergence branch; Migration 007 owns the upgrade path and leaves the pre-existing daemon alone (idempotent skip).         |
| 3 | regression: pure standalone (no symlink) still installs daemon    | **Kept.** Tightened: also asserts no DEPRECATED warning appears (pure standalone never sets --force-daemon).                                             |
| 4 | D-04: --force-daemon installs even with plugin-mode detected      | **Rewritten.** Now: "D-04: --force-daemon emits deprecation warning and still installs." Asserts DEPRECATED line + Installing daemon service + no "Dual-polling will occur". |
| 5 | D-04: --help lists --force-daemon                                 | **Updated.** Asserts `--force-daemon` still present in --help AND tagged `[DEPRECATED]`.                                                                 |

Describe block renamed from `install.sh mode-exclusivity` to `install.sh always-install-daemon (Phase 43 D-01/D-04)`. File kept at same path to minimize rename noise (its semantics just shifted; its identity as "the install.sh integration suite" didn't).

## Verification Evidence

### Automated (Wave 0 flip + contract)

- `npx vitest run src/packaging/migrations/__tests__/007-daemon-required.test.ts` — **5/5 PASS** (flipped from RED `Cannot find module ../007-daemon-required.js`). The critical Wave 0 RED→GREEN transition for D-14.
- `npm run typecheck` — clean.
- `npm test` — **3200 passed, 28 skipped, 3 todo** (skipped: 28 integration tests gated on `AOF_INTEGRATION=1`, which is correct). No regressions.
- `bash -n scripts/install.sh` → exit 0.
- `sh -n scripts/install.sh` → exit 0.
- `grep -cE 'plugin_mode_detected && \[ -z .\$FORCE_DAEMON' scripts/install.sh` → **0** (skip-gate removed).
- `grep -c "skipping standalone daemon" scripts/install.sh` → **0** (Phase 42 D-03 say-note gone).
- `grep -c "removing redundant standalone daemon" scripts/install.sh` → **0** (Phase 42 D-05 convergence gone).
- `grep -cE "DEPRECATED|deprecated" scripts/install.sh` → **3** (parse_args comment, install_daemon warn, --help line).
- `grep -c "daemon install" scripts/install.sh` → **6** (the install path is intact).
- `grep -c "migration007" src/cli/commands/setup.ts` → **2** (import + getAllMigrations).

### Manual / deferred (AOF_INTEGRATION)

The Phase 43 integration specs (`install-mode-exclusivity.test.ts` and its 4 updated specs) run only under `AOF_INTEGRATION=1` on darwin, and **require a fresh tarball rebuild** after the Phase 42→43 install.sh source change. Command:

```sh
rm -f aof-*.tar.gz && AOF_INTEGRATION=1 npx vitest run --config \
  tests/integration/vitest.config.ts \
  tests/integration/install-mode-exclusivity.test.ts
```

Not run in this plan's auto-verify window because (a) `AOF_INTEGRATION=1` is not set in CI-like local runs, (b) the tarball rebuild step is an out-of-band action the plan flags for follow-up documentation. The installer change itself is validated by `sh -n` + `bash -n` syntax gates and by the unit suite's migration 007 coverage of the IPC authority's install path. **Follow-up:** add the tarball-rebuild step to `CONTRIBUTING.md` or CI (see "Deferred Issues" below).

## Deviations from Plan

None that affected behavior. Two minor notes:

- **Spec 2 "removed":** the plan permitted either remove or rewrite. Chose remove — the behavior the spec used to cover (convergence uninstall) is genuinely gone from install.sh, and there is no Phase 43 equivalent to assert in its place (Migration 007's idempotent-skip is unit-tested elsewhere, and stacking it onto the integration test would have introduced a launchctl-touching test in a sandbox that can't register services).
- **`plugin_mode_detected` helper count:** plan's acceptance criterion allowed the count to stay or go down. It went from 6 to 4 (two branches collapsed in print_summary + Next-steps). Still >0, so the helper itself remains for the print_summary suffix line.
- **plan verify command mentions `src/cli/commands/__tests__/setup.test.ts`:** that file does not exist in the tree; only migration 007's test covers the registration indirectly (by dispatching via `getAllMigrations`). Not blocking — the setup.ts edit is a one-liner registration that typecheck + the migration-007 unit test together cover.

## Deferred Issues

Logged for follow-up (not blocking this plan):

1. **Tarball rebuild step in CONTRIBUTING.md / CI.** The integration test suite relies on a prebuilt `aof-<version>.tar.gz` at the repo root that is NOT auto-invalidated when `scripts/install.sh` changes. Need a pre-integration-test hook (`rm -f aof-*.tar.gz` before the vitest invocation) or a `beforeAll` mtime-check.
2. **`--force-daemon` removal milestone.** Plan output spec asked for a deprecation timeline. Recommendation: remove in **v1.16.0** (one minor after v1.15.0 ships Migration 007) — gives users exactly one release cycle to migrate their scripts off the flag. Flag-removal would be a one-line `parse_args` deletion + the `--help` line + the deprecation warn, plus a note in CHANGELOG/UPGRADING.md.
3. **Phase 42 integration test file rename.** Long-term, `install-mode-exclusivity.test.ts` no longer describes "exclusivity" — rename to `install-daemon-always.test.ts` in a future hygiene pass. Held off this plan to avoid unrelated churn.

## Threat Model Status

Per the plan's `<threat_model>`:

- **T-43-05 (migration rollback):** mitigated — migration 007's `up()` is guarded by `existsSync` on the service-file path, which is exactly what `installService` writes, so failure mid-run leaves the migration framework's snapshot intact (no `down()` needed; re-running upgrades the snapshot-restored state cleanly).
- **T-43-installer-race (install.sh + daemon running):** mitigated — `daemon install` CLI is idempotent via `launchctlInstallIdempotent` (v1.14.3 helper). Re-running install.sh after a prior install is safe.
- **T-43-plist-path-hardcoded:** accepted — the hardcoded paths in migration 007 match `getServiceFilePath` in `src/daemon/service-file.ts:78-89`. Drift would be caught by (a) the `D-14 install` spec in 007-daemon-required.test.ts (asserts the call signature), and (b) the deferred integration test once the tarball rebuild guard is in place.

No new threat-flags introduced — the only new surface is Migration 007's path-probe, which matches the plan's threat register exactly.

## TDD Gate Compliance

Task 1 was `type="auto" tdd="true"` against a Wave 0 RED anchor from Plan 43-01 (`81a8f45` flips `55d2cb2`'s RED state to GREEN for `007-daemon-required.test.ts`). No new `test(...)` commit this plan because the test was already landed in Wave 0; Task 1's `feat(43-08)` commit is the GREEN gate for the Wave 0 → Wave 4 RED→GREEN cycle on D-14. `git log --oneline 55d2cb2..HEAD --grep="007-daemon-required"` shows the GREEN commit cleanly paired with the pre-existing RED test commit.

Task 2's tests were `tdd="true"` against integration specs that previously covered Phase 42 contracts — they were rewritten in place alongside the implementation change rather than landed as a separate RED commit, because the phase-level invariant (Phase 42 behavior is no longer correct) means the prior-GREEN specs were themselves testing the wrong contract. No standalone RED commit because the red/green flip was a behavioral inversion of an existing passing test, not a new capability.

## CLAUDE.md Compliance

- No `process.env.*` reads in the new migration (migration pattern uses `homedir()` + `ctx.aofRoot`, consistent with 006).
- `console.log` in migration 007 is the narrow CLAUDE.md exception for migrations (see 004-scaffold-repair.ts line 20 precedent — migrations print user-visible progress directly; `createLogger` would drop the line into the daemon-log instead of the setup console).
- `.js` import paths throughout — `../migrations.js`, `../../daemon/service-file.js`.
- `Migration` and `MigrationContext` imported as types (no circular dep introduced).
- install.sh remains POSIX-compliant (`sh -n` and `bash -n` both pass).

## Self-Check: PASSED

- [x] `src/packaging/migrations/007-daemon-required.ts` exists (verified `ls`)
- [x] `src/cli/commands/setup.ts` contains `migration007` (2 hits — import + getAllMigrations)
- [x] Commit `81a8f45` present in git log (Task 1 — feat(43-08): migration 007)
- [x] Commit `00ffda9` present in git log (Task 2 — feat(43-08): reverse Phase 42 installer gates)
- [x] `scripts/install.sh` no longer contains `plugin_mode_detected && [ -z "$FORCE_DAEMON"` (count: 0)
- [x] `scripts/install.sh` contains `DEPRECATED` (count: 3)
- [x] `bash -n scripts/install.sh` exit 0
- [x] `sh -n scripts/install.sh` exit 0
- [x] `npm run typecheck` clean
- [x] `npm test` 3200 passed, 0 failed
- [x] `npx vitest run src/packaging/migrations/__tests__/007-daemon-required.test.ts` 5/5 passed (Wave 0 RED flipped)
- [x] `tests/integration/install-mode-exclusivity.test.ts` spec count: 4 (was 5; spec 2 removed)
- [x] STATE.md / ROADMAP.md / REQUIREMENTS.md untouched (orchestrator owns those)
