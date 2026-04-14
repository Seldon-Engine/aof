# Phase 42: Installer mode-exclusivity — Research

**Researched:** 2026-04-14
**Domain:** Shell installer + Node.js CLI wiring for platform-dual-mode service install
**Confidence:** HIGH (all claims verified against in-tree source; no library research required)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01 Detection signal:** Presence of `~/.openclaw/extensions/aof` (symlink OR directory) is sufficient to conclude plugin-mode. No openclaw CLI call, no `openclaw.json` read, no gateway probe in the default detection path. Residual stale-symlink false-positive risk is accepted.
- **D-02 Openclaw config fallback pattern:** Any openclaw-config reads that DO happen elsewhere in the installer or `aof setup` (not in detection — e.g. plugin wiring) must fall back to direct JSON read of `~/.openclaw/openclaw.json` when the `openclaw` CLI isn't on PATH. Pattern is already established in `src/cli/commands/setup.ts::wireOpenClawPluginDirect` — reuse, do not duplicate.
- **D-03 Default behavior when plugin-mode detected:** `install.sh::install_daemon()` auto-skips the standalone daemon install. No interactive prompt. Prints a one-line note (e.g. `"Plugin-mode detected — skipping standalone daemon. Scheduler runs in-process via openclaw gateway."`). Compatible with `curl|sh`, `--yes`, and CI pipes.
- **D-04 Override flag:** `--force-daemon`. Symmetric with existing `--force` override. Installs the daemon even when plugin-mode is detected. Must appear in `--help`.
- **D-05 Pre-existing dual-mode convergence:** When installer detects BOTH the plugin symlink AND an existing daemon plist at `~/Library/LaunchAgents/ai.openclaw.aof.plist`, it runs the `aof daemon uninstall` equivalent before the skip and prints `"Plugin-mode detected; removing redundant standalone daemon."`. Users who want both opt back in via `--force-daemon`.

### Claude's Discretion

- **Mode enforcement mechanism:** install-time only. A runtime `scheduler.mode` flag is not required for this phase. Planner may propose a cleaner runtime-aware approach if research surfaces one, but not required.
- **Existing dual-mode cleanup details** (e.g. `daemon.pid`, `daemon.sock`, stale log rotations): delegate to the existing `aof daemon uninstall` / `uninstallService()` code path — do not reinvent. Fix any gaps in the uninstaller, not the installer.
- **Message format / color / exact wording** of the skip note and the redundant-daemon note — executor discretion, within the `say` / `warn` style used by `install.sh`.
- **Detection helper location:** shell function in `install.sh`, or `aof setup --detect-mode` CLI subcommand, or both. Pick based on what minimizes duplication and keeps the detection path zero-dep.

### Deferred Ideas (OUT OF SCOPE)

- Runtime `scheduler.mode` flag enabling a booted daemon to stand down without reinstall. Own phase if needed.
- Thin-plugin IPC architecture (Phase 999.2, depends on this phase landing first).
- `aof doctor`-style mode audit command.
- Plugin-only feature parity verification (assumption; surface as blocker if a gap is found).
- Openclaw CLI probe for detection (explicitly rejected by D-01 — do NOT resurrect).

</user_constraints>

<phase_requirements>
## Phase Requirements

No numbered `REQ-XX` IDs exist for Phase 42 in ROADMAP.md — the phase description states `Requirements: TBD`. CONTEXT.md decisions `D-01` through `D-05` are the authoritative locked requirements for this research. Every finding below traces to one or more of those decisions or a Claude-discretion item.

| ID | Description | Research Support |
|----|-------------|------------------|
| D-01 | Symlink-OR-directory detection at `~/.openclaw/extensions/aof` | §Detection Implementation — POSIX `[ -L X ] \|\| [ -d X ]` test; zero-dep, fastest signal available, matches `deploy.sh` symlink target exactly (line 140 of `scripts/deploy.sh`) |
| D-02 | Direct JSON fallback when `openclaw` CLI absent | §Don't Hand-Roll — the `wireOpenClawPluginDirect` helper at `src/cli/commands/setup.ts:174-264` is the canonical pattern; any new openclaw-config reads reuse it. Detection path (D-01) does NOT need any openclaw-config read, so this is only relevant if planning surfaces new config reads. |
| D-03 | Auto-skip daemon install with one-line note | §Architecture Patterns — insert check at TOP of `install_daemon()` (install.sh:660), short-circuit before the `node ... daemon install` invocation. Use existing `say`/`warn` helpers. |
| D-04 | `--force-daemon` override flag in `--help` | §Flag Parsing — follow existing `--clean` / `--yes` / `--force` pattern at install.sh:78-139; add case arm, add global `FORCE_DAEMON=""`, add help line. |
| D-05 | Auto-uninstall pre-existing daemon on upgrade | §Architecture Patterns + §Idempotency — reuse `service_is_loaded` + `launchctl bootout` pattern already in `pause_live_writers`; call out to `node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall` for the full sequence (plist removal + socket/pid cleanup) rather than inlining. |

</phase_requirements>

## Summary

This is a **~30-line `install.sh` delta plus one Vitest test file** phase. There is no library research to do; every primitive required is already in the tree:

- Detection: `[ -L "$HOME/.openclaw/extensions/aof" ] || [ -d "$HOME/.openclaw/extensions/aof" ]` — a single POSIX shell test, no deps, matches the symlink that `scripts/deploy.sh:140` creates.
- Upgrade uninstall: `install.sh` already has the template — `service_is_loaded` + `launchctl bootout` at L383-413. The full uninstall sequence (plist removal, socket/pid cleanup) lives in `src/daemon/service-file.ts::uninstallService` and is invocable via `node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall --data-dir "$DATA_DIR"` — the exact same shape install.sh already uses at L663 for `daemon install`.
- Flag parsing: `install.sh::parse_args` (L78-146) has a well-established `case "$1" in ... ;; esac` pattern with sibling bool flags (`--clean`, `--yes`, `--force`) to copy.
- `--help`: plain `printf` block at L117-138 — add one line for `--force-daemon`.
- `print_summary`: two-branch "daemon installed" vs. "not installed" already exists (install.sh:726-730, 740-745); extend to three branches.

**Primary recommendation:** Land the detection as a shell function inside `install.sh` (call it `plugin_mode_detected`), NOT a new `aof setup --detect-mode` subcommand. The detection check runs BEFORE `aof setup` is even guaranteed to be installed (plugin-mode skip happens during `install_daemon` which runs after `run_node_setup`, but we want to keep the gate at install-script layer so it stays a one-liner and cannot be broken by a half-migrated `dist/cli/index.js`). Additionally expose the detection through `aof setup --detect-mode` only if the planner identifies a consumer for it — right now there is no consumer; the TS side already calls `detectOpenClaw()` for its own needs.

**Scope confirmation:** There is **no existing test harness for `install.sh` — no bats, no shellcheck in CI, no integration tests that exercise the built tarball through install.sh** (verified: `grep -r "install.sh" tests/` returns zero matches). Phase 42 must either add a Vitest integration test that shells out to `install.sh --tarball` against a fresh `$HOME` sandbox, OR add a Vitest-level test for a new TypeScript helper (if detection is split between bash and TS). Gap flagged below.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Plugin-mode detection (symlink check) | Install script (`install.sh`) | — | Runs before any Node.js code is guaranteed in PATH; stays pure shell, zero-dep |
| Daemon install invocation | Install script → Node CLI (`aof daemon install`) | TS `service-file.ts::installService` | Existing pattern: `install.sh:663` shells out to `node dist/cli/index.js daemon install` |
| Daemon uninstall on upgrade (D-05) | Install script → Node CLI (`aof daemon uninstall`) | TS `service-file.ts::uninstallService` | Same shape as install; reuses the full plist-removal + socket/pid cleanup path already tested in `daemon-cli.test.ts` |
| `--force-daemon` flag parsing | Install script | — | Pure shell — no TS side needs to know about it |
| User-facing skip / converge messages | Install script (`say` / `warn`) | — | Consistent with existing helper output |
| Openclaw-config fallback (D-02, only if surfaced in planning) | TS (`src/cli/commands/setup.ts::wireOpenClawPluginDirect`) | — | Already implemented; detection path does NOT need it |

## Standard Stack

### Core (already in the tree — nothing new to install)

| Component | Version | Purpose | Why Standard |
|-----------|---------|---------|--------------|
| `install.sh` (POSIX `/bin/sh`) | — | Top-level installer | `#!/bin/sh` shebang confirmed; uses `local` (bash/dash/ash extension, portable in practice) |
| Commander.js | `^14.0.1` | CLI routing (`aof daemon install/uninstall`, `aof setup`) | Already powers every existing CLI command — planner should NOT introduce a second parser |
| Vitest | `^3.0.0` | Unit + integration test runner | Project-wide standard; `tests/vitest.e2e.config.ts` handles serialized fork-pool E2E |
| `better-sqlite3`, `pino`, `zod` | — | Dependencies of daemon runtime — NOT touched by this phase | — |

### Supporting

| Component | Purpose | When to Use |
|-----------|---------|-------------|
| `say` / `warn` / `err` helpers in `install.sh:15-25` | Colored output | All new user-facing messages in installer |
| `service_is_loaded` (install.sh:383) | launchctl state probe | Determine whether existing daemon is actually loaded before attempting uninstall |
| `node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall --data-dir "$DATA_DIR"` | Full daemon uninstall | D-05 convergence step — reuse existing binary rather than inlining `launchctl bootout` + `unlinkSync(plist)` |
| `writeFileAtomic` (already in `setup.ts:14`) | Atomic JSON writes | Only relevant if D-02 path needs a new config write — not expected for Phase 42 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Shell function `plugin_mode_detected` in install.sh | New `aof setup --detect-mode` CLI subcommand | TS subcommand is unnecessary complexity — the detection has zero logic beyond a single file-existence test, and adding a CLI subcommand requires the `dist/` to exist before we can run detection, which defeats one goal (fast, early gate). Keep the check in bash. If the TS side ever grows a consumer, lift the logic then. |
| Inlined `launchctl bootout` + plist `rm` in install.sh | Shell out to `node ... daemon uninstall` | Inlining forks the uninstall logic away from `uninstallService()` — the moment `uninstallService` adds cleanup (e.g. future log rotation), install.sh silently drifts. Shell out. |
| `pgrep -f aof-daemon` to detect running daemon | File existence of `~/Library/LaunchAgents/ai.openclaw.aof.plist` | File-existence is the authoritative signal — a crashed daemon may have no live process but still be registered with launchd. The plist file is what causes re-spawn. Check the plist. |
| Bats / shellcheck-based install.sh test harness | Vitest integration test shelling out to `install.sh --tarball <path>` | Project has zero bats/shellcheck infrastructure today; bringing it in is out of scope for a ~30-line phase. Vitest already has the integration-test precedent (`tests/integration/*.test.ts`). |

**Installation:** No new packages required. `npm ci` already covers everything.

**Version verification:** Not applicable — no new deps to version-check. All tools used (`launchctl`, POSIX shell builtins, `node`, Commander.js `^14.0.1`) are already in the project.

## Architecture Patterns

### System Architecture Diagram

```
User runs: curl|sh OR sh install.sh [--force-daemon]
                                │
                                ▼
            ┌─────────────────────────────────┐
            │  install.sh::parse_args          │
            │  (new: --force-daemon → FORCE_DAEMON="true") │
            └─────────────────────────────────┘
                                │
                                ▼
            check_prerequisites ─► detect_existing_install
            ─► determine_version ─► download_tarball
                                │
                                ▼
            (if --clean) run_clean_flow_preinstall
                                │
                                ▼
            extract_and_install ─► run_node_setup
            ─► write_version_file ─► setup_shell_path
                                │
                                ▼
            ┌─────────────────────────────────┐
            │  install_daemon() — MODIFIED     │
            │                                  │
            │  NEW: plugin_mode_detected?      │
            │   ├─ YES + FORCE_DAEMON unset:   │
            │   │   ├─ plist exists?           │
            │   │   │   ├─ YES → aof daemon     │
            │   │   │   │        uninstall;    │
            │   │   │   │        print converge │
            │   │   │   │        message       │
            │   │   │   └─ NO  → print skip    │
            │   │   │            message        │
            │   │   └─ DAEMON_INSTALLED="" (skip install) │
            │   │                              │
            │   ├─ YES + FORCE_DAEMON="true":  │
            │   │   └─ warn "override"; fall   │
            │   │       through to install     │
            │   │                              │
            │   └─ NO (pure standalone — unchanged):     │
            │       └─ node ... daemon install │
            └─────────────────────────────────┘
                                │
                                ▼
            validate_install ─► print_summary (extended: 3rd branch)
```

Data-flow summary: the single new branch point lives at the top of `install_daemon()`. Everything before it is unchanged. Everything after it either proceeds normally (pure standalone or `--force-daemon`) OR short-circuits with `DAEMON_INSTALLED=""` so `print_summary` sees the skip state.

### Recommended Project Structure

```
scripts/
├── install.sh                # MODIFIED
│   ├── parse_args            # +1 case arm (--force-daemon), +1 help line
│   ├── plugin_mode_detected  # NEW — single-function helper
│   ├── install_daemon        # MODIFIED — gate at top
│   └── print_summary         # MODIFIED — extend daemon branch to 3 states
└── deploy.sh                 # UNCHANGED (it creates the symlink our detection relies on)

src/daemon/
├── service-file.ts           # UNCHANGED — uninstallService already covers the D-05 sequence
└── __tests__/
    └── service-file.test.ts  # MAY extend with an uninstallService test (currently none)

src/cli/commands/
├── daemon.ts                 # UNCHANGED — daemonUninstall already calls uninstallService
└── setup.ts                  # UNCHANGED unless planner picks the `--detect-mode` option

tests/
├── integration/              # NEW test file
│   └── install-mode-exclusivity.test.ts   # Vitest integration test shelling out to install.sh
└── e2e/                      # UNCHANGED
```

### Pattern 1: Shell-function detection (reuse of install.sh idioms)

**What:** Single POSIX function that returns 0 for plugin-mode, 1 otherwise. No side effects. Called from `install_daemon` AND from the pre-install D-05 check.

**When to use:** The detection gate. Every decision point in this phase.

**Example:**

```sh
# plugin_mode_detected — returns 0 if OpenClaw plugin integration is present.
# Detection signal (D-01): ~/.openclaw/extensions/aof exists as a symlink OR a directory.
# The symlink is canonically created by scripts/deploy.sh (line 140). A directory
# in the same slot indicates a legacy hand-copy install and also counts.
# Zero-dep, no CLI call, no config read, safe to call multiple times.
plugin_mode_detected() {
  ext_link="$OPENCLAW_HOME/extensions/aof"
  if [ -L "$ext_link" ] || [ -d "$ext_link" ]; then
    return 0
  fi
  return 1
}
```

Verified: `OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"` already exists at install.sh:47 — reuse.

Source: `scripts/deploy.sh:140` — `ln -s "${AOF_DIST}" "${PLUGIN_LINK}"` where `PLUGIN_LINK="${OPENCLAW_EXT}/aof"`. [VERIFIED: scripts/deploy.sh]

### Pattern 2: Flag parsing (copy `--clean` / `--yes` / `--force`)

**What:** Single `case` arm in `parse_args`, bool global variable defaulting to empty string.

**When to use:** Every new boolean flag in install.sh.

**Example:**

```sh
# --- in globals (around install.sh:46) ---
FORCE_DAEMON=""

# --- in parse_args (around install.sh:109, next to --force) ---
--force-daemon)
  FORCE_DAEMON="true"
  ;;

# --- in --help block (around install.sh:133, after --force) ---
printf "  --force-daemon          Install the standalone daemon even when OpenClaw\n"
printf "                          plugin-mode is detected. Not recommended — both\n"
printf "                          AOFService instances will poll the same data dir.\n"
```

Source: `scripts/install.sh:78-146` (existing `parse_args` + `--help` block). [VERIFIED: scripts/install.sh]

### Pattern 3: D-05 upgrade convergence (shell out to `aof daemon uninstall`)

**What:** Detect pre-existing plist, invoke the installed `aof daemon uninstall` to do the full teardown (bootout + plist removal + pid/sock cleanup), then continue with the skip.

**When to use:** Exactly once, at the top of `install_daemon`, when `plugin_mode_detected` returns 0 AND the plist file exists AND `FORCE_DAEMON` is unset.

**Example:**

```sh
install_daemon() {
  # Mode-exclusivity gate (Phase 42).
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
    # DAEMON_INSTALLED stays empty; print_summary branches on that.
    return 0
  fi

  if plugin_mode_detected && [ -n "$FORCE_DAEMON" ]; then
    warn "--force-daemon set: installing daemon despite plugin-mode detection. Dual-polling will occur."
  fi

  # Existing install path (unchanged from today).
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

Source: existing `install_daemon` at `scripts/install.sh:660-671` (two-line shell-out), `src/cli/commands/daemon.ts:312-320` (`daemonUninstall` wraps `uninstallService`), `src/daemon/service-file.ts:375-409` (full uninstall sequence: `launchctl bootout` → `unlinkSync(plist)` → `unlinkSync(daemon.sock)` → `unlinkSync(daemon.pid)`). [VERIFIED: all three files]

### Pattern 4: `print_summary` three-way branch

**What:** Extend the existing two-state branch to three states: plugin-skip, daemon installed, daemon not installed.

**Example:**

```sh
# In print_summary, replace lines 726-730:
if plugin_mode_detected && [ -z "$DAEMON_INSTALLED" ]; then
  printf "  Daemon: skipped (scheduler runs via OpenClaw plugin)\n"
elif [ -n "$DAEMON_INSTALLED" ]; then
  printf "  Daemon: installed and running\n"
else
  printf "  Daemon: not installed — run 'aof daemon install' to start\n"
fi
```

And update the "Next steps" block at L740-745 to skip the "3. Start the daemon" step when plugin-skip is active.

Source: `scripts/install.sh:726-745` (existing `print_summary` daemon branch). [VERIFIED: scripts/install.sh]

### Anti-Patterns to Avoid

- **Do NOT call `openclaw config get plugins.slots.memory` in the detection path.** This directly contradicts D-01 and re-introduces the exact cost the roadmap originally assumed (CLI dependency, timeout risk, config-parse edge cases). [CITED: CONTEXT.md D-01]
- **Do NOT inline `launchctl bootout` + plist `rm` into install.sh for the D-05 step.** `uninstallService` may grow new cleanup (log rotation, future watchdog state). Shell out to `aof daemon uninstall` — it's the same shell-out shape install.sh already uses for `daemon install`.
- **Do NOT add the detection as an `aof setup --detect-mode` subcommand ALONE.** Requires `dist/` to be present and `node` to work. Keep the primary detection in shell. A TS helper is optional and only justified if a non-installer consumer appears.
- **Do NOT introduce bats / shellcheck as a dependency for testing this phase.** Zero precedent in the repo, out of scope for a ~30-line delta. Use Vitest + `child_process.execFileSync` shelling into `install.sh --tarball`.
- **Do NOT touch `pause_live_writers` / `resume_live_writers`.** Those are for the mid-install "services may be writing while we move DATA_DIR" race — orthogonal to D-05 convergence. They already handle both `ai.openclaw.gateway` and `ai.openclaw.aof`; don't conflate.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Full daemon uninstall (bootout + plist removal + socket/pid cleanup) | Inline `launchctl bootout ...` + `rm ~/Library/LaunchAgents/ai.openclaw.aof.plist` + socket/pid rm | `node dist/cli/index.js daemon uninstall --data-dir "$DATA_DIR"` | `uninstallService` at `src/daemon/service-file.ts:375-409` already does all four steps + is cross-platform (darwin + linux). Shell-inline forks the logic. [VERIFIED: src/daemon/service-file.ts] |
| Openclaw config read (if D-02 is exercised) | New bash `grep`/`sed` over `openclaw.json` | Call out to existing TS `wireOpenClawPluginDirect` pattern, or add a small shared TS helper | Bash JSON parsing is fragile; `openclaw.json` has nested paths. Current pattern uses `node - "$config" <<'NODE'` heredocs (install.sh:843) when a write is needed — same shape works for reads. [VERIFIED: scripts/install.sh:820-910] |
| Launchctl state probe | `pgrep -f aof-daemon` in bash | `service_is_loaded` (install.sh:383) | `pgrep` misses stopped-but-registered services. `launchctl print` is authoritative. [VERIFIED: scripts/install.sh:383-385] |
| Plist-file-exists check | `[ -e "$plist" ]` | `[ -f "$plist" ]` | Prefer `-f` — rejects directories and dangling symlinks. |
| Flag parser | New parser | Existing `case "$1" in ... ;; esac` | One-arm extension — don't restructure. |

**Key insight:** This phase is about composition, not construction. Every primitive is already in the repo and battle-tested. Resist the urge to add a TS helper, a new shell-utility file, or a new test harness type.

## Runtime State Inventory

This phase involves behavioral change on upgrade (D-05), so runtime state matters. Each category must be verified before the planner can assume coverage.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None. The installer touches `$DATA_DIR` only via the existing preserve/restore cycle — Phase 42 adds no new data. Task store / event log / memory DB untouched. | None — verified by review of `extract_and_install` + `install_daemon` call sequence. |
| Live service config | `~/Library/LaunchAgents/ai.openclaw.aof.plist` (macOS). On Linux: `~/.config/systemd/user/ai.openclaw.aof.service`. These are the service files our D-05 step removes. `~/.openclaw/openclaw.json` plugin entries are untouched by Phase 42 (those remain valid — plugin-mode IS the target state). | D-05 step removes plist / systemd unit via `aof daemon uninstall`. |
| OS-registered state | launchd registration under `gui/$(id -u)/ai.openclaw.aof` (macOS); systemd user unit `ai.openclaw.aof` (linux). | `uninstallService` already issues `launchctl bootout` / `systemctl --user disable --now`. No new wiring needed. [VERIFIED: src/daemon/service-file.ts:379-391] |
| Secrets / env vars | `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN` are injected into the plist by `generateLaunchdPlist`. Removing the plist removes these registrations; no separate cleanup needed. `FORCE_DAEMON` is a new install-time shell variable only — not persisted anywhere. | None. |
| Build artifacts / installed packages | `~/.aof/dist/`, `~/.aof/node_modules/`, `~/.openclaw/extensions/aof` symlink. Phase 42 does NOT touch these — the plugin symlink is the DETECTION SIGNAL and must remain. | None — if we touched the symlink we'd break our own detection. |

**Orphaned daemon files after D-05 uninstall:** `uninstallService(dataDir)` explicitly removes `$DATA_DIR/daemon.sock` and `$DATA_DIR/daemon.pid` (service-file.ts:400-408). No orphans expected.

**Stale-symlink edge case (CONTEXT.md flagged):** If a previous install created `~/.openclaw/extensions/aof` and the user manually deleted openclaw but left the symlink dangling, detection returns true and daemon is skipped. Mitigation: `--force-daemon` is the documented escape hatch. Residual risk was accepted by D-01.

## Common Pitfalls

### Pitfall 1: Running detection before `$OPENCLAW_HOME` is set

**What goes wrong:** Helper function references `$OPENCLAW_HOME` before `parse_args` has run — `OPENCLAW_HOME` is populated via `${OPENCLAW_HOME:-$HOME/.openclaw}` at install.sh:47, which is GLOBAL scope and initialized at script load, so this pitfall is actually pre-mitigated. Still, any future refactor that moves `OPENCLAW_HOME` into `parse_args` would break detection.

**How to avoid:** Keep `OPENCLAW_HOME` assignment at global scope. If moved, audit all callers.

**Warning signs:** Empty string concatenation in the `ext_link` path (`/extensions/aof`), detection silently returning 1.

### Pitfall 2: `aof daemon uninstall` failure on D-05 aborting the install

**What goes wrong:** If `node ... daemon uninstall` returns non-zero (e.g. stale socket, permissions issue), `set -eu` at the top of install.sh aborts the whole install.

**How to avoid:** Suffix the invocation with `|| warn "..."` — D-05 cleanup is best-effort. If uninstall fails, the plist remains; on next boot the daemon respawns, duplicating with the plugin again — BUT the install itself completed. Emit a clear warning.

**Warning signs:** Installer exits with non-zero, plist still present, no stderr captured from `daemon uninstall`.

### Pitfall 3: `--force-daemon` silently overriding `--clean` side effects

**What goes wrong:** `--clean` removes `~/.openclaw/extensions/aof` via `remove_external_integration()`. Then `plugin_mode_detected` returns false for the rest of the install. `--force-daemon` becomes a no-op. User assumes it forced the daemon; in fact daemon installs unconditionally because plugin-mode wasn't detected.

**How to avoid:** Document that `--force-daemon` is only meaningful when plugin-mode WOULD be detected. In the warn message emitted at force-daemon-override time, qualify: `"plugin-mode detected → forcing daemon install"`. This keeps the log semantically truthful.

**Warning signs:** `--force-daemon` set but no warning line in output.

### Pitfall 4: Detecting a directory at `~/.openclaw/extensions/aof` that ISN'T a plugin

**What goes wrong:** User creates an empty directory at that path for an unrelated reason. Detection returns true, daemon skipped, they have no scheduler at all because no actual plugin is loaded.

**How to avoid:** Accept residual risk per D-01. `--force-daemon` is the escape hatch. Document in the skip message and `--help`.

**Warning signs:** User reports "tasks aren't dispatching after install" and no daemon plist exists.

### Pitfall 5: `install.sh` is `#!/bin/sh`; `[[ ]]` and bashisms break on dash

**What goes wrong:** Contributor adds `if [[ -L "$ext_link" ]]; then` — works on macOS bash-as-`/bin/sh` (because macOS `/bin/sh` IS bash), breaks on Ubuntu dash-as-`/bin/sh`.

**How to avoid:** Use POSIX `[ -L "$x" ] || [ -d "$x" ]`. Verified present elsewhere (install.sh:920).

**Warning signs:** `ShellCheck SC2039` (not run in CI today — regression gate missing).

### Pitfall 6: The printed skip / converge messages leak into parsed output

**What goes wrong:** If any future CI check pipes installer output through `grep -q "Daemon: installed"` and depends on that branch, the new branch could false-negative.

**How to avoid:** Document the three output states in the phase's PLAN.md. Grep patterns should match on `Daemon:` then any of three suffixes.

## Code Examples

### Example 1: POSIX symlink-OR-directory check

```sh
# Source: pattern verified against scripts/install.sh:920 (remove_external_integration)
ext_link="$OPENCLAW_HOME/extensions/aof"
if [ -L "$ext_link" ] || [ -e "$ext_link" ]; then
  # plugin-mode
fi
```

Note `-e` vs `-d`: install.sh:920 uses `-L ... || -e ...` for teardown; for *detection* we prefer `-L ... || -d ...` so a dangling file (not a symlink, not a directory) doesn't trip detection. Choose `-d` to be strict; `-e` matches existing remove logic. Executor picks; plan should note the chosen one.

### Example 2: Invoking aof daemon uninstall from install.sh

```sh
# Source: scripts/install.sh:663 — existing `daemon install` invocation shape
if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
  node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall \
    --data-dir "$DATA_DIR" 2>&1 || \
    warn "Daemon uninstall returned non-zero (continuing)"
fi
```

### Example 3: Vitest integration test shelling to install.sh

```ts
// Source: pattern adapted from tests/integration/*.test.ts (existing integration tests)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

describe("install.sh mode-exclusivity", () => {
  let sandbox: string;
  let fakeHome: string;
  let tarballPath: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "aof-install-"));
    fakeHome = join(sandbox, "home");
    mkdirSync(fakeHome, { recursive: true });
    // Pre-built tarball expected at repo root — CI step builds it, dev flow
    // needs `node scripts/build-tarball.mjs <version>` run first.
    tarballPath = join(process.cwd(), ".release-staging", "aof-v0.0.0-test.tar.gz");
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it("skips daemon install when plugin symlink is present", () => {
    // Create the plugin symlink BEFORE running install.
    mkdirSync(join(fakeHome, ".openclaw", "extensions"), { recursive: true });
    symlinkSync("/nonexistent/aof/dist", join(fakeHome, ".openclaw", "extensions", "aof"));

    const output = execFileSync("sh", [
      "scripts/install.sh",
      "--tarball", tarballPath,
      "--prefix", join(fakeHome, ".aof"),
      "--data-dir", join(fakeHome, ".aof-data"),
    ], {
      env: { ...process.env, HOME: fakeHome, OPENCLAW_HOME: join(fakeHome, ".openclaw") },
      encoding: "utf-8",
    });

    expect(output).toMatch(/Plugin-mode detected.*skipping standalone daemon/);
    expect(output).toMatch(/Daemon: skipped/);
    // No plist should have been created under the fake home.
    expect(existsSync(join(fakeHome, "Library", "LaunchAgents", "ai.openclaw.aof.plist"))).toBe(false);
  });

  // ... additional scenarios below (Validation Architecture)
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ROADMAP's original signal: `~/.openclaw/extensions/aof` AND `openclaw config get plugins.slots.memory == "aof"` | Symlink/directory check alone (D-01) | 2026-04-14 (this phase's discussion) | Zero-dep, offline-safe, no openclaw CLI requirement. Residual stale-symlink risk accepted. |
| Runtime `scheduler.mode` flag proposed for exclusivity | Install-time-only enforcement | 2026-04-14 (CONTEXT.md deferred) | Simpler. No new runtime branches. Matches the insight that if the daemon plist doesn't exist, there's nothing to stand down at runtime. |
| v1.14.3 introduced `launchctlInstallIdempotent` | Idempotent install sequence for daemon | 2026 (already shipped) | Daemon install re-run is safe. D-05 uninstall has NO equivalent idempotent wrapper — `uninstallService` is already idempotent-by-construction because it swallows `launchctl bootout` failures. Phase 42 does not need a new `launchctlUninstallIdempotent`. [VERIFIED: src/daemon/service-file.ts:375-391] |

**Deprecated / outdated:**
- Original ROADMAP detection signal (symlink AND config) — superseded by CONTEXT.md D-01. Do not revert.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `uninstallService()` at `src/daemon/service-file.ts:375-409` fully handles macOS + Linux teardown including pid/sock cleanup | Architecture Patterns §3, Don't Hand-Roll | If untrue, D-05 leaves orphans. **Mitigation: VERIFIED by reading service-file.ts lines 375-409 — socket/pid explicit unlink present.** [VERIFIED: src/daemon/service-file.ts] |
| A2 | `OPENCLAW_HOME` env var is accepted by install.sh and respected everywhere, enabling safe integration testing under a fake `$HOME` | Code Examples §3 | If some code paths hard-code `$HOME/.openclaw`, tests under a fake home leak into real `~/.openclaw`. **Mitigation: VERIFIED — install.sh:47 uses `${OPENCLAW_HOME:-$HOME/.openclaw}` and `remove_external_integration` / `unwire_openclaw_config` reference `$OPENCLAW_HOME`. Two stragglers at install.sh:263 and :271 reference `$HOME/.openclaw` directly — planner must update those or accept they're legacy-detection paths.** [VERIFIED: scripts/install.sh:263,271] |
| A3 | Vitest integration tests can shell out to a freshly-built tarball via `--tarball <path>` and fully exercise install.sh end-to-end | Validation Architecture | If `build-tarball.mjs` is only runnable in CI, local test runs fail. **Mitigation: PARTIALLY VERIFIED — `build-tarball.mjs` is a plain Node script at `scripts/build-tarball.mjs`; requires a `version` arg; writes to `.release-staging/`. Test setup must either `npm run build` then build a tarball, OR use `npx vitest` with a pre-existing tarball. Planner decision: choose between "build-then-test" CI cost vs. "bring-your-own-tarball" dev friction.** [VERIFIED: scripts/build-tarball.mjs] |
| A4 | Adding `--force-daemon` flag does NOT require changes in `src/cli/commands/daemon.ts` or `src/daemon/service-file.ts` | Architectural Responsibility Map | If the TypeScript side ends up needing a mode-awareness flag, scope grows. **Mitigation: VERIFIED — `--force-daemon` is install-script-only; it toggles whether install.sh invokes `node ... daemon install`. The TS CLI command is unchanged.** [VERIFIED: scripts/install.sh:660-671] |
| A5 | `install.sh` `#!/bin/sh` shebang under macOS `/bin/sh` (bash) and Linux `/bin/sh` (dash) both support `[ -L x ] || [ -d x ]` POSIX test chaining | Common Pitfalls §5 | None — both dash and bash in POSIX mode support this syntax. [VERIFIED: POSIX spec; existing install.sh:920 uses identical construct] |

**No `[ASSUMED]` claims remain unverified — every claim above was cross-checked against in-tree source during this research session.**

## Open Questions (RESOLVED)

1. **Where should the `--detect-mode` CLI subcommand go, if anywhere?**
   - What we know: No consumer exists today. Detection can be pure-shell.
   - What's unclear: Will Phase 999.2 (thin-plugin IPC) want a TS-side `aof doctor` / `aof status --mode` readout that reuses the same detection? If yes, putting the logic in TS now and shelling out from bash would avoid duplication later.
   - Recommendation: Land the shell function only. Revisit if Phase 999.2 surfaces a concrete consumer. One-liner in bash does not justify a TS helper prospectively.
   - **Resolution:** Shell function only in install.sh. No `aof setup --detect-mode` subcommand this phase — no consumer, and requires `dist/` to be present before the gate can run.

2. **Should `--force-daemon` warn or fail when used WITHOUT plugin-mode detected?**
   - What we know: It's a no-op when plugin is absent — daemon would install anyway.
   - What's unclear: Silent no-op vs. loud warn. Users may set it defensively in CI without knowing whether plugin is present.
   - Recommendation: Silent when plugin absent; warn ONLY when plugin IS present and flag overrides the skip. This keeps the warn semantically accurate ("you overrode an actual skip") and avoids spam.
   - **Resolution:** Silent no-op when plugin absent. Warn only when override actually overrides (plugin detected AND `--force-daemon` set). Matches "leave pure-standalone untouched" guarantee.

3. **Tarball-based integration test: build-on-every-run vs. fixture?**
   - What we know: `build-tarball.mjs <version>` produces `.release-staging/aof-v<version>.tar.gz`. Takes ~10-20s locally.
   - What's unclear: Whether CI budget supports building a tarball per test run, and whether a cached fixture would drift from source.
   - Recommendation: Build in a Vitest `beforeAll` (once per test file). Tag the test as integration, not unit — slow-path OK. If CI cost is too high, gate behind `AOF_INSTALLER_TEST=1`.
   - **Resolution:** `beforeAll` on-demand build gated by `existsSync` — if `.release-staging/*.tar.gz` exists (CI pre-step) reuse it; otherwise run `scripts/build-tarball.mjs`. Keeps test self-contained without forcing every local run to rebuild.

4. **Linux (systemd) coverage in Phase 42 tests?**
   - What we know: CLAUDE.md flags that plugin/standalone paths must BOTH stay green. The plist is macOS-specific; systemd unit path is `~/.config/systemd/user/ai.openclaw.aof.service`.
   - What's unclear: Whether we run the integration test on Linux CI at all today, or whether it's macOS-only.
   - Recommendation: Planner should examine `.github/workflows/` to determine CI matrix. If Linux-CI exists, the plist-absent path needs a `.service` analog. If macOS-only, document the gap explicitly and defer Linux-mode convergence to a follow-up.
   - **Resolution:** macOS-only for Phase 42 via `describe.skipIf(process.platform !== "darwin")`. Linux convergence deferred — document the gap explicitly in the integration test file header comment. Extending to systemd is a future phase if Linux users report dual-mode race.

5. **Openclaw-config reads in the installer (D-02 applicability)?**
   - What we know: Detection doesn't need any config read. `install.sh:820-910` already does config WRITES using a node heredoc.
   - What's unclear: Does any NEW code path in Phase 42 need to READ openclaw.json? Based on scope, no.
   - Recommendation: D-02 is latent — cited for completeness, but no Phase 42 code needs to act on it. If planning surfaces a new read, apply the `wireOpenClawPluginDirect` pattern.
   - **Resolution:** D-02 is latent for Phase 42. The detection path (D-01) is symlink-only and never reads `openclaw.json`. D-02 pattern (`wireOpenClawPluginDirect` at `src/cli/commands/setup.ts:174-264`) applies only if a future phase surfaces a new openclaw-config read in the installer.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `/bin/sh` (POSIX) | install.sh execution | ✓ | — | — |
| Node.js >= 22 | `aof daemon uninstall` shell-out | ✓ | 22.x (project requires) | If missing: install.sh `check_prerequisites` (L176) errors out already |
| `launchctl` | macOS daemon install/uninstall | macOS-only | — | Skip on Linux (service-file.ts handles via systemd) |
| `systemctl --user` | Linux daemon install/uninstall | Linux-only | — | Skip on macOS |
| Vitest `^3.0.0` | New integration test | ✓ (installed) | 3.x | — |
| Pre-built `aof-v*.tar.gz` | Integration test fixture | ✓ (built via `scripts/build-tarball.mjs`) | — | `beforeAll` build step |
| `bats` / `shellcheck` | — | ✗ | — | **Not needed** — Vitest integration test suffices. Do NOT introduce. |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None — all required tooling already present.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 3.x |
| Config file | `tests/integration/vitest.config.ts` (existing) for a new integration test file, OR `vitest.config.ts` (root) for pure TS unit tests |
| Quick run command | `npm test` (unit suite, ~10s) |
| Full suite command | `npm run test:all` (unit + E2E) |
| Integration-only | `npm run test:integration:plugin` (existing integration harness; Phase 42 adds a new `install-mode-exclusivity.test.ts` in the same dir) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| D-01 | Detection: symlink present at `~/.openclaw/extensions/aof` → `plugin_mode_detected` returns 0 | unit (bash function via `sh -c 'source install.sh; plugin_mode_detected && echo yes'`) OR integration (full install.sh run) | `npx vitest run tests/integration/install-mode-exclusivity.test.ts` | ❌ Wave 0 |
| D-01 | Detection: directory (non-symlink) at same path → returns 0 | integration | same | ❌ Wave 0 |
| D-01 | Detection: path absent → returns 1 (pure standalone regression) | integration | same | ❌ Wave 0 |
| D-03 | Plugin-mode fresh install, no prior daemon → install.sh skips daemon, prints expected note, exit 0, no plist created | integration | same | ❌ Wave 0 |
| D-05 | Plugin-mode upgrade over existing daemon → installer uninstalls daemon, prints converge note, exits 0, plist is gone, no orphan `daemon.pid` / `daemon.sock` | integration | same | ❌ Wave 0 |
| — | Pure standalone regression: symlink absent → daemon installs exactly as today | integration | same | ❌ Wave 0 |
| D-04 | `--force-daemon` override: symlink present, flag set → daemon installs despite plugin-mode, warn emitted | integration | same | ❌ Wave 0 |
| D-04 | `--help` includes `--force-daemon` | unit (parse `install.sh --help` output via execFile) | same | ❌ Wave 0 |
| — | `uninstallService()` idempotency: calling twice leaves no orphans | unit (add to `src/daemon/__tests__/service-file.test.ts`) | `npx vitest run src/daemon/__tests__/service-file.test.ts` | ❌ Wave 0 (gap — no existing uninstall unit test, as verified by Grep) |

### Nyquist test set (minimum-sufficient)

Five integration scenarios, all in one new file `tests/integration/install-mode-exclusivity.test.ts`, plus one unit test in `service-file.test.ts`:

1. **Plugin-mode fresh install (D-01 + D-03)**
   - Setup: fake `$HOME`; pre-create symlink `~/.openclaw/extensions/aof → /dev/null`.
   - Run: `sh install.sh --tarball <fixture> --prefix $HOME/.aof --data-dir $HOME/.aof-data`.
   - Assert: exit 0; stdout contains `"Plugin-mode detected — skipping standalone daemon"`; no plist at `$HOME/Library/LaunchAgents/ai.openclaw.aof.plist`.

2. **Plugin-mode upgrade over existing daemon (D-05)**
   - Setup: fake `$HOME`; symlink as above; pre-create a dummy plist file at `$HOME/Library/LaunchAgents/ai.openclaw.aof.plist` (content irrelevant — detection is file-exists based); pre-populate `$DATA_DIR/daemon.pid` and `.sock`.
   - Run: same install.
   - Assert: exit 0; stdout contains `"removing redundant standalone daemon"`; plist absent; `daemon.pid` and `daemon.sock` removed.
   - Caveat: in a fake-home sandbox, `launchctl bootout` fails harmlessly (the service was never actually registered). The test should verify that install.sh tolerates this and continues.

3. **Pure standalone regression (unchanged behavior)**
   - Setup: fake `$HOME`; NO symlink.
   - Run: same install.
   - Assert: exit 0; stdout contains `"Daemon installed and running"` OR `"Daemon install failed (non-fatal)"` (the latter is acceptable inside a fake-home sandbox because real `launchctl bootstrap` will fail against a non-user domain — the install must still succeed overall). Assert NO skip message. This test primarily ensures the detection does not false-positive.

4. **`--force-daemon` override (D-04)**
   - Setup: symlink present (plugin-mode detected).
   - Run: `sh install.sh --tarball <fixture> --force-daemon ...`.
   - Assert: exit 0; stdout contains `"--force-daemon set"` warning; daemon install sequence runs (verify by grepping for `"Installing daemon service..."`).

5. **`--help` shows `--force-daemon` (D-04)**
   - Run: `sh install.sh --help`.
   - Assert: exit 0; stdout contains `"--force-daemon"`.

6. **Unit test: `uninstallService()` is safe to call twice (D-05 + Claude's-discretion cleanup gap)**
   - Setup: inject mock `execSync`; pre-create dummy plist; first call removes it; second call is a no-op.
   - Assert: no throw on second call; `execSync("launchctl bootout ...")` failures are swallowed.
   - Add to `src/daemon/__tests__/service-file.test.ts` (currently has no uninstall tests — verified via Grep).

### Sampling Rate

- **Per task commit:** `npm test` (unit suite — excludes integration; ~10s). Ensures the service-file unit test passes.
- **Per wave merge:** `npm run test:integration:plugin` (adds the new integration file; requires pre-built tarball in `.release-staging/`).
- **Phase gate:** `npm run test:all` green (unit + E2E), plus a fresh `npm run build && node scripts/build-tarball.mjs 0.0.0-test && npx vitest run tests/integration/install-mode-exclusivity.test.ts`.

### Wave 0 Gaps

- [ ] `tests/integration/install-mode-exclusivity.test.ts` — new file, covers D-01, D-03, D-04, D-05 via install.sh shell-out.
- [ ] Extension to `src/daemon/__tests__/service-file.test.ts` — add `uninstallService()` idempotency test (no existing coverage — verified by `grep "uninstall" src/daemon/__tests__/` returns no matches).
- [ ] Tarball fixture: determine whether the integration test's `beforeAll` should build a tarball on-demand, or whether CI builds it as a pre-step and the test consumes `.release-staging/*.tar.gz`. Decision note in PLAN.md.
- [ ] Linux CI gap: if `.github/workflows/` runs Linux tests, confirm the symlink/plist scenarios are macOS-only and add a guard (`describe.skipIf(process.platform !== 'darwin')`) OR extend to systemd. Out of scope to change CI matrix; planner must at minimum document the gap.

*(No existing installer test harness to preserve — this is all greenfield for installer coverage.)*

## Project Constraints (from CLAUDE.md)

Directives extracted from the project's `CLAUDE.md` that bear directly on this phase:

- **TDD — failing test first.** Wave 0 must write the integration test with the expected strings BEFORE modifying `install.sh`. The test will fail at "exit 0" until install.sh implements the skip path.
- **Small atomic commits to main.** Phase should produce ~3 commits max: (1) helper + detection, (2) flag + `install_daemon` gate + summary, (3) D-05 convergence + tests. No long-lived branch.
- **Root causes, no bandaids.** The current race (both AOFService instances polling `~/.aof/data/`) is the root cause being addressed at install-time. Do NOT add a runtime workaround that detects-and-silences one instance — that IS the bandaid CONTEXT.md explicitly deferred.
- **"Fragile — Tread Carefully" §Plugin/standalone executor wiring.** `plugin.ts`, `openclaw/adapter.ts`, `daemon/daemon.ts` — Phase 42 MUST NOT touch any of these three files. Every change is in `scripts/install.sh` plus tests. If planning surfaces a perceived need to edit them, re-scope.
- **No `console.*` in core modules.** Not applicable — Phase 42 is shell + test, no core modules touched.
- **Config via `getConfig()`.** Not applicable — install.sh precedes the config registry.
- **Barrel files = pure re-exports.** Not applicable.
- **No circular deps; run `npx madge --circular --extensions ts src/` if any .ts change.** Applicable only if tests add a new helper module. Running madge is the existing norm.
- **Orphan vitest workers.** After any aborted test run (install.sh integration test is shell-out heavy and more likely to be killed), run the orphan-kill command documented in CLAUDE.md.
- **When mistakes get corrected, document in `lessons.md`.** If any of the 5 pitfalls above materializes during execution, log it there.
- **Release process:** NEVER `release-it --no-npm`. Not relevant to Phase 42 execution itself (we don't cut a release in-phase) but relevant to shipping the changes afterward — the installer lives in the tarball, which is only rebuilt at release time. Users on `curl|sh` get the new behavior on next release.

## Security Domain

Installers and privilege-sensitive code warrant a minimum security review even for a small phase.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | No auth surface changed |
| V3 Session Management | no | No sessions |
| V4 Access Control | yes (indirect) | Daemon uninstall requires user-level launchd access — inherited from `launchctl` invoking user; no privilege escalation introduced |
| V5 Input Validation | yes | `--force-daemon` is a parameterless boolean; no injection surface. Path `$OPENCLAW_HOME` already quoted in all existing uses — retain quoting in new code. |
| V6 Cryptography | no | — |

### Known Threat Patterns for installer / shell

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Symlink attack on detection path (attacker pre-creates `~/.openclaw/extensions/aof` to force daemon-skip) | Tampering | Attack model: attacker has write access to user's home dir. If yes, attacker already owns the install anyway. Out of scope for installer hardening. |
| Command injection via `$OPENCLAW_HOME` containing shell metachars | Tampering | All new references must quote the variable. `[ -L "$OPENCLAW_HOME/extensions/aof" ]` is safe (test builtin, quoted). The shell-out `node ... daemon uninstall --data-dir "$DATA_DIR"` uses separate args — safe. |
| `$DATA_DIR` injection into the shell-out | Tampering | Already mitigated by existing `daemon install` invocation at install.sh:663; Phase 42 reuses identical quoting. |
| Leaking uninstall status to an untrusted observer | Information Disclosure | Messages are user-facing on stdout; no new sensitive info (no tokens, keys, or paths beyond what existing install.sh already prints). |

No new crypto, no new auth, no new secrets. Review gate: a code review that spot-checks quoting on every new `$`-expansion reference is sufficient.

## Sources

### Primary (HIGH confidence) — in-tree source read during this session

- `scripts/install.sh` — parsed for arg parsing (L78-146), globals (L29-47), `service_is_loaded`/`pause_live_writers` (L383-413), `install_daemon` (L660-671), `print_summary` (L704-747), `detect_existing_install` (L248-279), `remove_external_integration` (L915-943), `unwire_openclaw_config` (L820-910), main (L971-994)
- `src/daemon/service-file.ts` — full file; `uninstallService` at L375-409, `launchctlInstallIdempotent` at L295-326, `AOF_SERVICE_LABEL` at L40
- `src/cli/commands/daemon.ts` — `daemonInstall` L264-306, `daemonUninstall` L312-320, command registration L536-599
- `src/cli/commands/setup.ts` — `wireOpenClawPluginDirect` L174-264, `registerSetupCommand` L553-586
- `src/packaging/openclaw-cli.ts` — `detectOpenClaw` L101-115, `openclawConfigGet` L35-50
- `src/plugin.ts` — plugin entry confirming in-process AOFService registration
- `src/daemon/daemon.ts` — daemon entry confirming standalone AOFService registration
- `scripts/deploy.sh` — symlink creation at L140 (`ln -s "${AOF_DIST}" "${PLUGIN_LINK}"`)
- `scripts/build-tarball.mjs` — tarball build for integration test fixtures
- `package.json` — version 1.14.3, test scripts, Vitest ^3.0.0, Commander ^14.0.1
- `.planning/config.json` — confirms `workflow.nyquist_validation` absent (defaults to enabled)
- `.planning/phases/42-installer-mode-exclusivity/42-CONTEXT.md` — locked decisions
- `.planning/ROADMAP.md` — Phase 42 goal + Phase 999.2 dependency
- `CLAUDE.md` — engineering standards, fragile-area warnings, orphan-vitest guidance
- `.serena/memories/plugin-executor-path-analysis.md` — dual-mode architectural analysis

### Secondary (MEDIUM confidence)

- POSIX shell spec on `[ -L ]` / `[ -d ]` / `[ -f ]` — well-established; no URL fetched this session
- launchd `bootout` / `kickstart` semantics — confirmed by the idempotent install pattern in `launchctlInstallIdempotent` comments

### Tertiary (LOW confidence)

- None. All claims in this research trace to verified in-tree sources.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — everything already in the tree, no new libraries
- Architecture: HIGH — all four code patterns verified against existing install.sh / service-file.ts
- Pitfalls: HIGH — the `#!/bin/sh` + `local` idiom, `set -eu` abort risk, and stale-symlink corner are all concrete findings from reading the code
- Test strategy: MEDIUM — the absence of any installer test harness is verified (HIGH), but the choice between on-demand tarball build vs. CI fixture is a planner decision (MEDIUM)
- D-05 uninstall completeness: HIGH — verified by reading `uninstallService` line-by-line

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (30 days — installer code is stable, v1.14.3 idempotency fix just landed, no reason to expect rapid drift)
