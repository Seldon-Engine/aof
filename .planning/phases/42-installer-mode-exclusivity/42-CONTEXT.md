# Phase 42: Installer mode-exclusivity — Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Make `aof` installation mode-aware so plugin-mode (AOFService loaded in-process by the OpenClaw gateway) and standalone-mode (`aof-daemon` launchd/systemd service) cannot both run AOFService against the same `~/.aof/data/` directory. Installer detects plugin-mode during `install_daemon()` and stands down the standalone daemon — by default skipping the install, and on upgrades by proactively uninstalling a pre-existing redundant daemon.

Out of scope (separate phases / deferred):
- Thin-plugin architecture / IPC-based single-writer (Phase 999.2 — depends on this one).
- Runtime `scheduler.mode` flag that lets a booted daemon stand down without reinstall.
- Symmetric opposite: "daemon installed but plugin missing" is already the default standalone flow; no new logic needed.

</domain>

<decisions>
## Implementation Decisions

### Detection signal
- **D-01:** Presence of `~/.openclaw/extensions/aof` (symlink OR directory) is sufficient to conclude plugin-mode. No openclaw CLI call, no openclaw.json read, no gateway probe in the default path.
  - Rationale: fast, zero dependency, works offline. Uninstall flow already clears the symlink (`install.sh::remove_external_integration`), so stale-symlink false positives are rare. Accept the residual risk.
- **D-02:** Any openclaw-config reads that DO happen elsewhere in the installer or `aof setup` (not in detection, but e.g. plugin wiring) must fall back to direct JSON read of `~/.openclaw/openclaw.json` when the `openclaw` CLI isn't on PATH. This is the same pattern `src/cli/commands/setup.ts::wireOpenClawPluginDirect` already uses — reuse, don't duplicate.

### Default behavior when plugin-mode detected
- **D-03:** `install.sh::install_daemon()` **auto-skips** the standalone daemon install. No interactive prompt. Prints a one-line note, e.g. `"Plugin-mode detected — skipping standalone daemon. Scheduler runs in-process via openclaw gateway."`
  - Rationale: matches the curl|sh non-interactive contract, compatible with `--yes` and CI pipes, zero new failure surface.
- **D-04:** Override flag: `--force-daemon`. Symmetric with the existing `--force` override pattern. Installs the daemon even when plugin-mode is detected. Documented in `--help`.
- **D-05:** Pre-existing dual-mode installs (user had BOTH plugin AND daemon from pre-42 days) are converged to plugin-only on upgrade: installer detects plugin + existing daemon plist at `~/Library/LaunchAgents/ai.openclaw.aof.plist`, runs the `aof daemon uninstall` equivalent before the skip, prints `"Plugin-mode detected; removing redundant standalone daemon."`
  - Rationale: one-shot convergence. Users who still want the daemon opt back in via `--force-daemon`. The alternative (warn + leave both) preserves the very bug this phase exists to fix.

### Claude's Discretion
- **Mode enforcement mechanism:** install-time only — if the daemon plist doesn't exist, there's no duplicate-polling problem to solve at runtime. A runtime `scheduler.mode` flag is not needed for this phase. If research surfaces a cleaner runtime-aware approach, planner may add it, but it's not a requirement.
- **Existing dual-mode details** beyond the uninstall step (e.g. cleaning up `daemon.pid`, `daemon.sock`, stale log rotations after auto-uninstall): defer to the existing `aof daemon uninstall` code path — do not reinvent. If gaps surface during planning, fix in the uninstaller rather than the installer.
- **Message format / color / exact wording** of the skip note and the redundant-daemon note — planner/executor discretion.
- **Detection helper location:** whether the plugin-mode check lives as a shell function in `scripts/install.sh`, as an `aof setup --detect-mode` CLI subcommand invoked from bash, or both. Planner picks based on what minimizes duplication with existing `wireOpenClawPlugin` logic.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase spec
- `.planning/ROADMAP.md` §Active Phases / Phase 42 — goal, detection signal hint, scope boundary.

### Existing installer code (the code that must change)
- `scripts/install.sh` — `install_daemon()` (~L635), `detect_existing_install()`, `remove_external_integration()` (L915), `pause_live_writers()` / `resume_live_writers()` (L364–404).
- `src/cli/commands/daemon.ts` — `daemonInstall` / `daemonUninstall` handlers; entry point for `--force-daemon` behavior.
- `src/daemon/service-file.ts` — `installService`, `uninstallService`, `launchctlInstallIdempotent` (the idempotency helper just landed in v1.14.3).
- `src/cli/commands/setup.ts` — `wireOpenClawPluginDirect` (L157) is the canonical example of "openclaw CLI unavailable → read the JSON directly." D-02 reuses this pattern.
- `src/packaging/openclaw-cli.ts` — `detectOpenClaw`, `openclawConfigGet` (for reference; NOT used in detection per D-01).

### Core runtime that must NOT double-poll
- `src/plugin.ts` — OpenClaw plugin entry; spins up in-process AOFService.
- `src/daemon/daemon.ts` — standalone daemon; also spins up AOFService.
- `src/dispatch/scheduler.ts` — the thing both paths end up calling `poll()` on, against the same task store.

### Release / deploy integration points
- `scripts/deploy.sh` — creates `~/.openclaw/extensions/aof → ~/.aof/dist/` symlink that our detection relies on. Informational: deploy doesn't need to change for Phase 42, but tests should exercise the path it creates.
- `scripts/build-tarball.mjs` — produces the tarball that carries `install.sh`. Phase 42 changes ship inside this tarball.

### Project-level
- `CLAUDE.md` §"Fragile — Tread Carefully" — "Plugin/standalone executor wiring: Two separate code paths. Changes risk breaking one mode while testing the other." Direct warning for this phase. Planner must include tests for both modes.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`install.sh::service_is_loaded` + `pause_live_writers`** (L360, L364): already probe launchctl state and conditionally bootout. The daemon-uninstall-on-upgrade step (D-05) can lean on this same pattern instead of reinventing it.
- **`install.sh::remove_external_integration`** (L915): already has the clean-uninstall recipe — plist removal, symlink teardown. Don't duplicate; call or factor out.
- **`src/daemon/service-file.ts::uninstallService`**: the TypeScript-side uninstaller. If `install.sh` needs to invoke uninstall on an existing daemon, this is the entry point — same path the `aof daemon uninstall` CLI command runs.
- **`src/cli/commands/setup.ts::wireOpenClawPluginDirect`** (L157): the fallback-to-JSON pattern. D-02 should reuse the same file-read helper rather than adding a new one.

### Established Patterns
- **Shell bool variables for flags**: `install.sh` uses empty-string-or-"true" convention (`CLEAN_INSTALL=""` / `CLEAN_INSTALL="true"`). `--force-daemon` should follow: `FORCE_DAEMON=""` default, set to `"true"` when flag present.
- **`say` / `warn` / `err` helpers**: standard in `install.sh` for colored output. Use for all new messages.
- **Config-as-code over runtime-as-code**: today's exclusivity problem is papered-over at runtime (both modes start AOFService, gateway wins the race). Phase 42 moves enforcement to install-time — no new runtime branching.

### Integration Points
- **`install.sh::main()` flow** (~L948): `install_daemon` runs between `setup_shell_path` and `print_summary`. New mode check runs *inside* `install_daemon` at the top, BEFORE the node call.
- **`print_summary`**: the "Daemon installed and running" vs. "Run `aof daemon install` to start" branch already exists; extend with a third branch: "Scheduler runs via openclaw plugin (standalone daemon skipped)."
- **`--help` / arg parser** at `install.sh:78`: new `--force-daemon` case slots in next to `--force`.

</code_context>

<specifics>
## Specific Ideas

- User's framing from backlog entry: "Leave existing pure-standalone installs alone." — that guarantee holds here: symlink absent → daemon installs exactly as today. No behavior change for users who don't use the OpenClaw plugin.
- User chose the simplest detection (symlink only) over the ROADMAP's stated "symlink AND openclaw config == aof" signal. Record this divergence: the ROADMAP pre-dates today's insight that openclaw CLI fallback and stale-config edge cases make config-level checks costlier than they're worth.
- The fix is a ~30-line install.sh delta plus one small helper and tests covering both modes. Not a large phase.

</specifics>

<deferred>
## Deferred Ideas

- **Runtime `scheduler.mode` flag** enabling a booted daemon to stand down without reinstall. Useful for `aof mode switch plugin|standalone` UX. Belongs in its own phase if we ever need it — for now, install-time enforcement is enough.
- **Thin-plugin IPC architecture** — daemon owns the scheduler singleton, plugin is a bridge. Phase 999.2. Depends on Phase 42 landing first so both modes can coexist during migration.
- **`aof doctor`-style mode audit** — a command that reports which mode is active, whether state is consistent (no orphan plist when plugin is present, no orphan symlink when daemon is running), and offers to fix. Nice-to-have hygiene tool.
- **Plugin-only feature parity verification** — does the openclaw plugin have 100% of the daemon's features (memory manager health, CLI views, watchdog, etc.)? Phase 42 assumes yes. If planning surfaces a gap, it's blocker-level and should be flagged immediately rather than masked by `--force-daemon`.

</deferred>

---

*Phase: 42-installer-mode-exclusivity*
*Context gathered: 2026-04-14*
