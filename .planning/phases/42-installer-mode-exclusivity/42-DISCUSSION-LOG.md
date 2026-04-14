# Phase 42: Installer mode-exclusivity — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-14
**Phase:** 42-installer-mode-exclusivity
**Areas discussed:** Detection signal, Default behavior when detected, Pre-existing dual-mode migration

---

## Gray area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Detection signal | How to reliably detect plugin-mode integration | ✓ |
| Default behavior when detected | What install.sh does by default | ✓ |
| Mode enforcement mechanism | Install-time vs runtime config vs plugin-config | |
| Existing dual-mode installs | What happens on upgrade when both are installed | |

**Notes:** User deferred mode enforcement mechanism and existing dual-mode details to Claude's discretion. Third area (pre-existing dual-mode migration) surfaced as follow-up during Area 2 and was answered inline.

---

## Detection signal

### Q: What signals should install.sh combine to conclude the user is running plugin-mode?

| Option | Description | Selected |
|--------|-------------|----------|
| Symlink alone (simplest) | `~/.openclaw/extensions/aof` exists → plugin-mode. Fast, offline, risk: stale-symlink false positives | ✓ |
| Symlink + openclaw config check | ROADMAP's stated signal; more robust, requires openclaw CLI fallback | |
| Live gateway probe | Definitive; requires gateway up at install time | |
| All three with fallback chain | Most robust, most code | |

**User's choice:** Symlink alone.
**Rationale captured:** Uninstall already clears the symlink, residual risk is acceptable, zero-dependency detection wins.

### Q: What if openclaw CLI isn't on PATH (so we can't run `openclaw config get`)?

| Option | Description | Selected |
|--------|-------------|----------|
| Fall back to direct file read | Read `~/.openclaw/openclaw.json` directly, mirrors `wireOpenClawPluginDirect` | ✓ |
| Fall back to symlink-only | Trust the symlink, skip config confirmation | |
| Abort with error | Require CLI | |

**User's choice:** Fall back to direct file read.
**Notes:** Applies to config reads elsewhere in the installer/setup (not to Phase 42's detection, since symlink-only detection doesn't invoke config at all). Locks in the reuse-`wireOpenClawPluginDirect`-pattern rule.

---

## Default behavior when detected

### Q: What should the installer do by default when plugin-mode is detected?

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-skip, print note | Silent skip + one-line note; curl|sh-friendly | ✓ |
| Prompt user interactively | Breaks `--yes` / non-interactive flow | |
| Install but disable | Leaves dormant plist, more state to manage | |
| Error out | Hostile default UX | |

**User's choice:** Auto-skip with note.

### Q: What override flag name lets a user install the daemon anyway?

| Option | Description | Selected |
|--------|-------------|----------|
| `--force-daemon` | Symmetric with existing `--force`; explicit intent | ✓ |
| `--standalone` | Names the mode | |
| `--daemon` (toggle) | Conflicts with current default semantics | |
| `AOF_INSTALL_MODE` env var | Less discoverable; good for CI | |

**User's choice:** `--force-daemon`.

---

## Pre-existing dual-mode migration (follow-up)

### Q: User already has BOTH plugin AND daemon from pre-Phase 42. Run installer — what happens to the existing daemon?

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-uninstall daemon, print note | One-shot convergence to plugin-mode | ✓ |
| Warn, leave both running | Preserves the duplicate-polling bug | |
| Refuse upgrade | Hostile to automated upgrades | |

**User's choice:** Auto-uninstall with note.
**Rationale:** Only option that actually fixes the bug Phase 42 exists to fix. `--force-daemon` is the escape hatch.

---

## Claude's Discretion

- Mode enforcement mechanism: install-time only (skip daemon → no duplicate polling at runtime)
- Exact wording/formatting of skip-note and redundant-daemon-removal-note
- Detection helper location (install.sh function vs `aof setup --detect-mode` vs both)
- Cleanup ordering in the auto-uninstall path (delegate to existing `uninstallService`)

## Deferred Ideas

- Runtime `scheduler.mode` flag for reinstall-free mode switching
- Phase 999.2 thin-plugin IPC architecture (blocked on 42)
- `aof doctor` mode-audit command
- Plugin-mode feature-parity verification against daemon
