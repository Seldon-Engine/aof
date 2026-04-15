---
status: deferred
phase: 42-installer-mode-exclusivity
source: [42-VERIFICATION.md]
started: 2026-04-14T20:44:41Z
updated: 2026-04-15T00:00:00Z
---

## Current Test

[deferred — user skipped human UAT on 2026-04-15 to advance the milestone]

## Tests

### 1. Real-launchd D-05 convergence on a live macOS host
expected: Running `scripts/install.sh` against a host that has both the openclaw plugin symlink AND a running `ai.openclaw.aof` launchd agent removes the daemon (launchctl bootout + plist removal + sock/pid cleanup) and leaves the system with the plugin only. `launchctl list | grep openclaw.aof` is empty after install; `aof daemon status` reports standalone daemon absent.
result: skipped
reason: deferred — integration-test coverage substitutes for real-launchd run; promoted Phase 43 scoping takes priority

### 2. End-to-end curl | sh upgrade path with released tarball
expected: On a real host with a pre-existing Phase-41 (or earlier) dual-mode install, running the published `curl -fsSL https://.../install.sh | sh` converges to plugin-only: daemon plist gone, plugin still functional via openclaw gateway, task polling no longer duplicated between plugin and daemon.
result: skipped
reason: deferred — will be exercised by next release's smoke test

### 3. Pure-standalone upgrade byte-identical
expected: On a host WITHOUT the openclaw plugin symlink, running the installer behaves identically to pre-42 releases: daemon plist installed, launchd service registered, `Daemon: installed and running` summary line printed. No `Plugin-mode detected` output.
result: skipped
reason: deferred — no bare host available, covered by integration test fixture

### 4. `--force-daemon` override on a plugin host
expected: On a host WITH the plugin symlink, running `install.sh --force-daemon` bypasses both the D-01/D-03 skip AND the D-05 convergence. Daemon plist is installed; `--force-daemon set (override)` warning appears in stdout; `launchctl list | grep openclaw.aof` shows the service loaded.
result: skipped
reason: deferred — integration test covers flag parsing path

## Summary

total: 4
passed: 0
issues: 0
pending: 0
skipped: 4
blocked: 0

## Gaps

### Gap A: install.sh:690 D-05 success message fires before CLI-binary guard (advisory, not blocking)
status: open
severity: high (narrow edge case)
source: 42-REVIEW.md
description: `say "Plugin-mode detected; removing redundant standalone daemon."` at scripts/install.sh:690 runs unconditionally before the `[ -f "$INSTALL_DIR/dist/cli/index.js" ]` guard at L691. On a fresh install where the tarball has been extracted but the dist binary is missing (edge case — interrupted extraction, custom prefix without the expected layout), the user sees a success message while the plist silently survives. Launchd re-spawns the daemon on next boot.
remediation: Move the `say` line inside the `if [ -f ... ]` block; add a `warn "CLI binary not found at ..., leaving existing plist in place"` on the else branch. ~3-line patch.
