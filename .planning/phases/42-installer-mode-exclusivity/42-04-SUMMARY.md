---
phase: 42-installer-mode-exclusivity
plan: 04
subsystem: infra
tags: [installer, shell, posix, launchd, mode-exclusivity, d-05, upgrade-convergence]

# Dependency graph
requires:
  - phase: 42-installer-mode-exclusivity
    provides: plugin_mode_detected helper (Plan 02), install_daemon skip+warn branches (Plans 02/03), --force-daemon flag (Plan 03), uninstallService idempotency coverage (Plan 01)
provides:
  - D-05 upgrade convergence in install_daemon (pre-existing plist detection + daemon uninstall shell-out)
  - Plan 04 closes the mode-exclusivity phase: all 5 integration specs GREEN
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "POSIX plist existence gate: [ -f \"$plist\" ] before shell-out (rejects directories + dangling symlinks)"
    - "`|| warn` suffix on shell-out under `set -eu` (T-42-01 mitigation: best-effort uninstall, installer continues on non-zero)"
    - "Shell-out to `node dist/cli/index.js daemon uninstall --data-dir ...` rather than hand-rolling bootout+rm in shell (reuses uninstallService cross-platform logic)"

key-files:
  created:
    - .planning/phases/42-installer-mode-exclusivity/42-04-SUMMARY.md
  modified:
    - scripts/install.sh

key-decisions:
  - "Shell-out to `daemon uninstall` rather than inlining launchctl bootout+plist rm+sock/pid cleanup. Rationale: uninstallService is already cross-platform (macOS bootout + linux systemctl), idempotent (Plan 01 unit coverage), and the canonical teardown path. Duplicating in POSIX shell would fork the logic — per RESEARCH.md §Don't Hand-Roll."
  - "Plist pre-check stays macOS-only (`$HOME/Library/LaunchAgents/...`). Linux dual-mode convergence would need an analogous systemd unit pre-check; out of scope for Phase 42 (deliberately deferred — see §Deferred Issues)."
  - "Kept `|| warn` instead of `|| true` so a failed uninstall still emits user-visible signal. Under `set -eu` (install.sh:11) a bare `|| true` would silence legitimate problems; `warn` surfaces them non-fatally."

patterns-established:
  - "Install_daemon skip branch is now a two-armed if/else inside `plugin_mode_detected && [ -z \"$FORCE_DAEMON\" ]`: plist-present → converge, plist-absent → skip. Future phases needing mode-aware teardown (e.g. Phase 999.2 thin-plugin) extend this branching."

requirements-completed: [D-05]

# Metrics
duration: 4min
completed: 2026-04-14
---

# Phase 42 Plan 04: D-05 Upgrade Convergence Summary

**Install.sh now detects pre-existing daemon plist under plugin-mode and proactively shells out to `aof daemon uninstall` before the skip, converging dual-mode installs to plugin-only. Integration spec 2 (D-05 upgrade) flips RED → GREEN; all 5 integration specs now GREEN. Phase 42 implementation work is complete.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-14T20:26:21Z
- **Completed:** 2026-04-14T20:29:56Z
- **Tasks:** 1 (single auto-TDD task — ~14-line diff on scripts/install.sh)
- **Files modified:** 1 (scripts/install.sh: +14 / -2)

## Accomplishments

- Added D-05 convergence block inside `install_daemon`'s plugin-mode skip branch (scripts/install.sh:686-700): if `$HOME/Library/LaunchAgents/ai.openclaw.aof.plist` exists, emits `say "Plugin-mode detected; removing redundant standalone daemon."` then shells out to `node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall --data-dir "$DATA_DIR" 2>&1 || warn "Daemon uninstall returned non-zero (continuing — plist may already be gone)"`. If no plist present, the existing pre-42 skip note fires instead.
- Integration spec 2 (D-05 upgrade convergence) flipped RED → GREEN. Specs 1, 3, 4, 5 remain GREEN (no regression). Plan 01's unit idempotency coverage (3 specs) remains GREEN.
- Full unit suite `npm test`: 3048 passed / 18 skipped / 0 failed.

## Task Commits

1. **Task 1: Add D-05 upgrade convergence** — `140674c` (feat)

**Plan metadata commit:** follows after SUMMARY.md + STATE.md + ROADMAP.md are staged.

## Files Modified

- `scripts/install.sh` (+14 / -2 lines) — inside `install_daemon`'s skip branch.

## Final `install_daemon` Body (All 4 Plans Applied)

```sh
install_daemon() {
  # Mode-exclusivity gate (Phase 42, D-03).
  # When plugin-mode is detected, skip the standalone daemon install unless
  # --force-daemon (D-04) overrides. D-05: if a pre-existing daemon plist
  # exists, converge to plugin-only by shelling out to `daemon uninstall`.
  if plugin_mode_detected && [ -z "$FORCE_DAEMON" ]; then
    plist="$HOME/Library/LaunchAgents/ai.openclaw.aof.plist"
    if [ -f "$plist" ]; then
      # D-05: pre-existing dual-mode install — converge to plugin-only.
      say "Plugin-mode detected; removing redundant standalone daemon."
      if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
        node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall \
          --data-dir "$DATA_DIR" 2>&1 || \
          warn "Daemon uninstall returned non-zero (continuing — plist may already be gone)"
      fi
    else
      say "Plugin-mode detected — skipping standalone daemon. Scheduler runs in-process via openclaw gateway."
    fi
    return 0
  fi

  if plugin_mode_detected && [ -n "$FORCE_DAEMON" ]; then
    warn "--force-daemon set: installing daemon despite plugin-mode detection. Dual-polling will occur."
  fi

  # Existing install path — unchanged from pre-Phase 42.
  if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
    say "Installing daemon service..."
    if node "$INSTALL_DIR/dist/cli/index.js" daemon install \
      --data-dir "$DATA_DIR" 2>&1; then
      DAEMON_INSTALLED="true"
      say "Daemon installed and running"
    else
      warn "Daemon install failed (non-fatal) — run 'aof daemon install' manually"
    fi
  fi
}
```

Planes of ownership across the 4 plans:
- **Plan 01:** RED scaffold (integration test + uninstallService idempotency unit coverage).
- **Plan 02:** `plugin_mode_detected()` helper + initial skip gate + 3-way `print_summary`.
- **Plan 03:** `FORCE_DAEMON=""` global + `--force-daemon)` parse arm + `--help` entry + warn-branch splice inside `install_daemon`.
- **Plan 04 (this):** D-05 plist pre-check + `daemon uninstall` shell-out inside the skip branch.

## Full Spec Matrix — Phase 42 Final State

### Integration (`tests/integration/install-mode-exclusivity.test.ts`, AOF_INTEGRATION=1)

| Spec | Requirement | Status | Turned Green By |
|------|-------------|--------|-----------------|
| D-01/D-03: skips daemon install when plugin symlink is present | D-01, D-03 | ✅ GREEN | Plan 02 |
| D-05: removes pre-existing daemon on upgrade with plugin present | D-05 | ✅ GREEN | **Plan 04** |
| regression: pure standalone (no symlink) still installs daemon | — | ✅ GREEN | Plan 02 |
| D-04: --force-daemon installs even with plugin-mode detected | D-04 | ✅ GREEN | Plan 03 |
| D-04: --help lists --force-daemon | D-04 | ✅ GREEN | Plan 03 |

### Unit (`src/daemon/__tests__/service-file.test.ts` — `uninstallService idempotency`)

| Spec | Threat Ref | Status | Added In |
|------|------------|--------|----------|
| double-call: second uninstall is a no-op | T-42-01 | ✅ GREEN | Plan 01 |
| missing plist: ENOENT swallowed | T-42-01 | ✅ GREEN | Plan 01 |
| missing sock/pid: ENOENT swallowed | T-42-01 | ✅ GREEN | Plan 01 |

### Post-plan verification run (darwin, 2026-04-14T20:27Z)

- `AOF_INTEGRATION=1 npx vitest run --config tests/integration/vitest.config.ts tests/integration/install-mode-exclusivity.test.ts` → **5 passed / 5**
- `npx vitest run src/daemon/__tests__/service-file.test.ts` → **35 passed / 35**
- `npm test` → **3048 passed / 18 skipped / 0 failed**
- `bash -n scripts/install.sh` → exit 0
- `git diff src/plugin.ts src/openclaw/adapter.ts src/daemon/daemon.ts src/daemon/service-file.ts src/cli/commands/daemon.ts` → empty (fragile trio + daemon CLI untouched)

## Decisions Made

1. **Shell-out, don't hand-roll.** Calling `node dist/cli/index.js daemon uninstall --data-dir ...` re-uses the cross-platform `uninstallService` that already handles macOS bootout + plist rm + Linux systemctl disable + sock/pid cleanup. Reinventing in POSIX shell would fork the logic and drop the idempotency guarantees Plan 01's unit specs enforce.
2. **`|| warn` over `|| true` under set -eu.** A bare `|| true` would silence legitimate failures. `warn` emits yellow `!` so the user sees the convergence step went sideways, yet the installer continues — T-42-01 mitigation.
3. **Plist pre-check uses `[ -f "$plist" ]`, not `[ -e "$plist" ]`.** `-f` rejects directories and dangling symlinks; a regular-file check is the honest signal that there's a real daemon plist to uninstall.
4. **macOS-only plist detection is acceptable for Phase 42.** Linux dual-mode convergence (systemd unit pre-check) is deliberately deferred — the integration test is already `describe.skipIf(platform !== "darwin")`, and the pure-skip branch still fires on Linux (if a Linux user ever has both plugin + systemd unit, they hit the else-branch skip note and the systemd unit stays in place; the plugin simply dominates at runtime). Documented as a known gap in §Deferred Issues.

## Deviations from Plan

None. Plan 04 executed exactly as written. The 14-line edit landed at the predicted insertion point inside `install_daemon`, the target spec flipped GREEN on first run, and no other specs regressed. No fragile TS files touched. No TS changes.

## Issues Encountered

### Stale tarball required rebuild before integration run

- **Found during:** pre-test preflight. After editing `scripts/install.sh`, the pre-existing `aof-1.14.3.tar.gz` at repo root was built from Plan 03's install.sh (no D-05 block), so the integration test would have shelled into the old installer and failed spec 2 for the wrong reason.
- **Fix:** `rm -f aof-1.14.3.tar.gz && node scripts/build-tarball.mjs 1.14.3` before running `npx vitest run … install-mode-exclusivity.test.ts`.
- **Follow-up implication:** Future Phase 42-style plans that touch `scripts/install.sh` should include a `rm aof-*.tar.gz` step before their integration verification. Not a code bug — the integration test's `beforeAll` uses `if (!existsSync(TARBALL))` for caching, which means tarball rebuilds are caller-responsible. Could be turned into a `beforeAll: rebuild-if-older-than-install.sh-mtime` optimization, but that's YAGNI for Phase 42.

### Launchd leakage from the regression spec (continuation of Plan 02/03 issue)

- The `regression` integration spec installs a real daemon which registers against `gui/$UID` domain (sandboxed `HOME` scopes file paths but not launchctl sessions). Plans 02 and 03 both flagged this. After this plan's integration run I observed `ai.openclaw.aof` in `launchctl list` pointing at PID 65305.
- **Cleanup performed:** `launchctl bootout gui/$UID/ai.openclaw.aof` followed by `rm -f ~/Library/LaunchAgents/ai.openclaw.aof.plist`. Final `launchctl list | grep openclaw.aof` → empty.
- **Plan 04 did NOT add an `afterEach` launchctl cleanup** despite Plans 02 and 03 flagging it. Rationale: the PLAN.md for 42-04 scoped the edit to `scripts/install.sh` only and did not include a test-harness hygiene change. Adding an `afterEach` in this plan would have been out-of-scope (Rule 4 territory — it's not strictly needed for spec 2 to pass). Logged for Phase 42 retrospective and for anyone re-running the suite locally. A future Phase 42.1 or a test-harness housekeeping phase should add `afterEach(() => { try { execSync("launchctl bootout gui/$UID/ai.openclaw.aof") } catch {} })` to the integration test file.

### Orphan vitest workers

- Killed stray `node (vitest N)` processes before and after the integration run per CLAUDE.md guidance. No orphans observed during this plan's execution — all runs completed cleanly.

### Vitest RPC timeout (cosmetic)

- The integration run reported `1 error` — a `Timeout calling "onTaskUpdate"` unhandled RPC error. This is a vitest 3.x worker-pool quirk unrelated to our assertions; test status was "5 passed" and all per-spec logs showed green checkmarks. Documented as a known cosmetic issue, not a Plan 04 regression.

## User Setup Required

None. Installer-only change — no user-facing config, no migration, no env var changes. Users who upgrade with a dual-mode install (pre-42 plugin + daemon) will have the daemon auto-uninstalled on next `install.sh` run with output:

```
✓ Plugin-mode detected; removing redundant standalone daemon.
Daemon uninstalled. Service file removed.
```

Users who still want the daemon can re-opt in via `install.sh --force-daemon`.

## Manual-Only Verifications

Per VALIDATION.md §Manual-Only Verifications, the following behaviors cannot be exercised by the integration suite and require a developer's real Mac:

1. **Real-launchd daemon unload on a developer's Mac (D-05).**
   - **Setup:** On a Mac with BOTH plugin symlink (`~/.openclaw/extensions/aof`) and a real daemon plist (`~/Library/LaunchAgents/ai.openclaw.aof.plist`) loaded (`launchctl list | grep ai.openclaw.aof` shows a running PID).
   - **Run:** `curl -fsSL <install-url>/install.sh | sh` or `sh ./install.sh` from a local tarball.
   - **Expected:** Installer emits `Plugin-mode detected; removing redundant standalone daemon.` → shell-out to `daemon uninstall` → output includes `Daemon uninstalled. Service file removed.`
   - **Verify:**
     - `launchctl list | grep ai.openclaw.aof` → empty
     - `ls ~/Library/LaunchAgents/ai.openclaw.aof.plist` → No such file
     - `ls ~/.aof-data/daemon.{pid,sock}` → No such file
     - `ps aux | grep aof-daemon | grep -v grep` → empty
   - Re-run installer → idempotent: "Plugin-mode detected — skipping standalone daemon" (plist-absent branch) with no errors.

2. **`curl | sh` non-interactive end-to-end (D-03).** Requires uploaded release artifact; exercise post-release.

3. **Linux (systemd) path.** Out of scope for Phase 42's integration test; see §Deferred Issues.

## Deferred Issues

1. **Linux dual-mode convergence** — the plist pre-check is hardcoded to `$HOME/Library/LaunchAgents/ai.openclaw.aof.plist`. A Linux user with both plugin symlink and `~/.config/systemd/user/ai.openclaw.aof.service` will hit the plist-absent branch (skip note), and the stale systemd unit will persist. Reaching parity requires a sibling `[ -f "$HOME/.config/systemd/user/ai.openclaw.aof.service" ]` check that also shells out to `daemon uninstall`. Deferred to a future phase; `uninstallService` is already cross-platform, so the Linux extension is purely a POSIX-shell branch addition. Out of scope for Phase 42 (confirmed by RESEARCH.md §Wave 0 Gaps Linux gap and CONTEXT.md §Claude's Discretion).

2. **Integration-harness launchd leakage** — the regression spec leaves a registered `ai.openclaw.aof` in `gui/$UID` domain after each run. Plan 02 and Plan 03 summaries both flagged this. The fix is a one-liner `afterEach` block that runs `launchctl bootout gui/$UID/ai.openclaw.aof` with `try/catch`. Not added in Plan 04 because PLAN.md scoped the edit to `scripts/install.sh`. Recommended for a Phase 42.1 or a standalone test-harness hygiene plan.

## Next Phase Readiness

Phase 42 implementation is complete. No further plans in this phase. Remaining phase-level steps per PLAN.md §output:
- `/gsd-verify-work 42` — verifier sweep (architect persona pass over all 4 summaries).
- `/gsd-commit-phase 42` — phase-level metadata commit and ROADMAP rollup.

Blockers: None.

## TDD Gate Compliance

Plan 04's task declared `tdd="true"`. Plan 01 scaffolded spec 2 (D-05 upgrade) as RED in commit `f9057f8`. Plan 04's `140674c` is the GREEN commit turning it green. No new RED test was written — the RED infrastructure was already in place from Plan 01, matching the phase's TDD chain (Plan 01 = RED-only, Plans 02-04 = GREEN transitions). No REFACTOR commit was needed — the diff is already minimal at +14/-2 lines.

## Self-Check: PASSED

- `test -f scripts/install.sh` → FOUND
- `grep -q "LaunchAgents/ai.openclaw.aof.plist" scripts/install.sh` → FOUND (line 687)
- `grep -q "removing redundant standalone daemon" scripts/install.sh` → FOUND (line 690)
- `grep -q 'daemon uninstall' scripts/install.sh` → FOUND (line 692)
- `grep -q -- '--data-dir "\$DATA_DIR"' scripts/install.sh` → FOUND (line 693 — shell-out continuation)
- `grep -q "Daemon uninstall returned non-zero" scripts/install.sh` → FOUND (line 694)
- `grep -q '\[ -f "\$plist" \]' scripts/install.sh` → FOUND (line 688)
- `bash -n scripts/install.sh && sh -n scripts/install.sh` → exit 0 (POSIX conformant)
- `git log --oneline | grep 140674c` → FOUND (feat(42-04): add D-05 upgrade convergence to installer)
- `git diff src/plugin.ts src/openclaw/adapter.ts src/daemon/daemon.ts src/daemon/service-file.ts src/cli/commands/daemon.ts` → empty (fragile trio + daemon CLI untouched)
- `AOF_INTEGRATION=1 npx vitest run --config tests/integration/vitest.config.ts tests/integration/install-mode-exclusivity.test.ts` → **5 passed / 5** (all integration specs GREEN)
- `npx vitest run src/daemon/__tests__/service-file.test.ts` → **35 passed / 35**
- `npm test` → **3048 passed / 18 skipped / 0 failed** (unit suite GREEN)
- Post-run launchd cleanup verified: `launchctl list | grep openclaw.aof` → empty

---

*Phase: 42-installer-mode-exclusivity*
*Completed: 2026-04-14*
*Phase implementation complete — 4/4 plans landed.*
