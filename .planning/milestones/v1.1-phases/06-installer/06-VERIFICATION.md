---
phase: 06-installer
verified: 2026-02-26T18:23:58Z
status: passed
score: 9/9 must-haves verified
gaps: []
human_verification:
  - test: "Run curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh on a fresh machine with Node >= 22 and OpenClaw"
    expected: "AOF installs to ~/.aof, directories scaffolded, plugin wired, success summary printed, aof commands work"
    why_human: "Cannot execute a real network install or invoke openclaw CLI in this static verification environment"
  - test: "Run the installer on a machine without Node >= 22"
    expected: "Clear error message printed, exit 1, no files modified"
    why_human: "Requires a real shell environment with a different Node version to trigger the prerequisite check"
  - test: "Run the installer twice on a machine with an existing AOF install"
    expected: "Upgrade completes without deleting tasks/, events/, memory/, state/ data; version file updated"
    why_human: "Requires a live install + re-run to observe backup/restore behavior end-to-end"
---

# Phase 6: Installer Verification Report

**Phase Goal:** A person who has never seen AOF can install it on a machine with Node >= 22 and OpenClaw using a single curl command — and running it again upgrades without data loss
**Verified:** 2026-02-26T18:23:58Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Installer downloads from real GitHub repository (not a placeholder) | VERIFIED | `channels.ts` line 42: `GITHUB_REPO = "d0labs/aof"` — no placeholder remains. `install.sh` uses `d0labs/aof` for API query (line 220) and tarball download URL (line 253). |
| 2 | `curl -fsSL <url>/install.sh | sh` invokes a safe POSIX shell script | VERIFIED | `scripts/install.sh` passes `sh -n` syntax check. All logic wrapped in `main()`. `set -eu` at top. Trap-based cleanup registered before any operations. |
| 3 | Installer checks Node >= 22 and exits with clear error if absent | VERIFIED | `check_prerequisites()` parses `node --version`, compares major version, prints install link and exits 1 on failure. Also checks tar, curl/wget, write permissions. |
| 4 | Fresh install: tarball extracts correctly and `npm ci` runs | VERIFIED | `extractTarball()` in `updater.ts` uses `execSync("tar -xzf ...")` with 60s timeout. `build-tarball.mjs` includes `package-lock.json` so `npm ci --production` succeeds. `install.sh` falls back to `npm install` if lockfile absent. |
| 5 | Fresh install: workspace directories scaffolded at `~/.aof` | VERIFIED | `runWizard()` in `wizard.ts` creates: `tasks/backlog`, `tasks/ready`, `tasks/in-progress`, `tasks/review`, `tasks/blocked`, `tasks/done`, `events`, `data`, `org`, `memory`, `state`, `logs`. Also writes `.gitignore` and `org/org-chart.yaml`. |
| 6 | Upgrade path: existing data backed up before overwrite, restored after | VERIFIED | `extract_and_install()` in `install.sh` backs up `tasks/`, `events/`, `memory/`, `state/`, `data/`, `.aof/`, `logs/`, `memory.db`, `memory-hnsw.dat` before extraction. Restores all on success. Restores from backup on extraction failure. |
| 7 | installer auto-detects OpenClaw and wires AOF as plugin (soft requirement) | VERIFIED | `wireOpenClawPlugin()` in `setup.ts` calls `detectOpenClaw()`, `registerAofPlugin()`, `configureAofAsMemoryPlugin()`, `openclawConfigSet()`. If OpenClaw not found, prints warning and continues — soft requirement honored. Health check with rollback on failure. |
| 8 | `aof setup --auto` is fully automatic with zero interactive prompts | VERIFIED | `runSetup()` accepts `auto: boolean`. When `auto=true`, `runWizard()` called with `interactive: false`. No user input paths anywhere in `setup.ts`. CLI registered with `--auto` flag. |
| 9 | `install.sh` delegates post-extraction logic to Node.js setup command | VERIFIED | `run_node_setup()` in `install.sh` (line 380) calls `node "$INSTALL_DIR/dist/cli/index.js" setup --auto --data-dir "$INSTALL_DIR" ${IS_UPGRADE:+--upgrade} ...`. `registerSetupCommand` imported and registered in `src/cli/index.ts` line 35/186. |

**Score:** 9/9 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/packaging/channels.ts` | Real GitHub repository constant | VERIFIED | `GITHUB_REPO = "d0labs/aof"` at line 42. No placeholder. Used in all fetch URLs. |
| `src/packaging/updater.ts` | Working `extractTarball()` using tar command | VERIFIED | `execSync("tar -xzf ...")` at line 343. `execSync` imported at line 12. 60s timeout. Error wrapped with descriptive message. |
| `scripts/build-tarball.mjs` | Tarball with `package-lock.json` included | VERIFIED | `package-lock.json` in `required` array at line 23. |
| `scripts/install.sh` | POSIX shell entry point for `curl \| sh` | VERIFIED | 448 lines. `#!/bin/sh`. Passes `sh -n`. `main()` wrapper. `trap cleanup EXIT`. All 8 flow functions implemented. |
| `src/cli/commands/setup.ts` | Node.js setup orchestrator | VERIFIED | 337 lines. `runSetup()` exported at line 245. `registerSetupCommand()` exported at line 303. Fresh/upgrade/legacy flows. OpenClaw wiring with rollback. |
| `src/packaging/wizard.ts` | Wizard scaffolds `memory/`, `state/`, `logs/` directories | VERIFIED | All three added to `directories` array at lines 100-102. `.gitignore` includes `*.db`, `*.dat` patterns. |
| `src/cli/index.ts` | `setup` command registered | VERIFIED | `import { registerSetupCommand }` at line 35. `registerSetupCommand(program)` at line 186. |
| `src/packaging/__tests__/updater.test.ts` | `extractTarball` integration test passing | VERIFIED | `describe("extractTarball integration", ...)` at lines 304-336. All 10 tests pass (9 existing + 1 new). |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `scripts/install.sh` | `src/cli/commands/setup.ts` | `node dist/cli/index.js setup --auto` | WIRED | Line 380: `node "$INSTALL_DIR/dist/cli/index.js" setup --auto --data-dir "$INSTALL_DIR" ...` |
| `src/cli/commands/setup.ts` | `src/packaging/wizard.ts` | `runWizard()` call | WIRED | Line 13: import. Line 276: called for fresh installs with `interactive: !auto` |
| `src/cli/commands/setup.ts` | `src/packaging/openclaw-cli.ts` | `registerAofPlugin` + `configureAofAsMemoryPlugin` | WIRED | Lines 17-25: import. Lines 173, 183: both called in `wireOpenClawPlugin()` |
| `src/cli/commands/setup.ts` | `src/packaging/migrations.ts` | `runMigrations()` for upgrade path | WIRED | Line 14: import. Line 263: called when `upgrade || legacy` |
| `src/packaging/channels.ts` | `api.github.com` | `GITHUB_REPO` constant in fetch URLs | WIRED | Line 42: `GITHUB_REPO = "d0labs/aof"`. Lines 220-221: used in `fetchReleaseManifest()` and `fetchCanaryManifest()` URLs. |
| `src/packaging/updater.ts` | `tar` command | `execSync` in `extractTarball()` | WIRED | Line 12: `execSync` imported. Line 343: `execSync(\`tar -xzf "${tarballPath}" -C "${targetDir}"\`)` |
| `scripts/install.sh` | `api.github.com/repos/d0labs/aof` | `determine_version()` | WIRED | Line 220: `RELEASE_URL="https://api.github.com/repos/d0labs/aof/releases/latest"` |
| `scripts/install.sh` | `github.com/d0labs/aof` releases | `download_tarball()` | WIRED | Line 253: `DOWNLOAD_URL="https://github.com/d0labs/aof/releases/download/v${VERSION}/aof-v${VERSION}.tar.gz"` |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| INST-01 | 06-02-PLAN.md | `curl \| sh` installer detects OS, architecture, Node >= 22, existing OpenClaw | SATISFIED | `check_prerequisites()` checks Node >= 22, tar, curl/wget, write permissions; `detect_existing_install()` checks for modern and legacy installs |
| INST-02 | 06-01-PLAN.md | Installer downloads release tarball from GitHub and extracts correctly | SATISFIED | `extractTarball()` implemented with `tar -xzf` via `execSync`; all 10 updater tests pass |
| INST-03 | 06-02-PLAN.md | Installer runs wizard (directory scaffolding, org chart template, health check) | SATISFIED | `runWizard()` called in `runSetup()` for fresh installs; scaffolds 12 directories + org-chart.yaml + .gitignore |
| INST-04 | 06-02-PLAN.md | Installer auto-detects OpenClaw gateway and wires AOF as plugin | SATISFIED | `wireOpenClawPlugin()` in `setup.ts` calls `detectOpenClaw()`, `registerAofPlugin()`, `configureAofAsMemoryPlugin()`; health check with rollback |
| INST-05 | 06-02-PLAN.md | Running installer on existing install upgrades without losing tasks/events/memory data | SATISFIED | `extract_and_install()` in `install.sh` backs up all data dirs before extraction, restores after; `--upgrade` flag passed to `aof setup` |
| INST-06 | 06-01-PLAN.md | Channels.ts repo URL points to real GitHub repository | SATISFIED | `GITHUB_REPO = "d0labs/aof"` — confirmed real repo per user direction; no placeholder remains |

All 6 INST-* requirements satisfied. No orphaned requirements found.

---

## Repository URL Note

Plan 01 was written with `demerzel-ops/aof` as the target repository. During execution of plan 01, a fix commit `6bc105d` corrected this to `d0labs/aof` per user direction. The user prompt for this verification confirms `d0labs/aof` is correct. All URLs in `channels.ts`, `install.sh`, and the curl comment in `install.sh` consistently use `d0labs/aof`.

One pre-existing stale URL found outside phase 06 scope: `src/cli/commands/system-commands.ts` line 329 contains `aof/aof` placeholder for the self-update download URL. This file was last modified in commit `5af4fcc` (pre-phase-06 refactor), not by any phase 06 plan. It is flagged for awareness but does not affect phase 06 goal achievement.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/packaging/wizard.ts` | 172 | `github.com/xavierxeon/aof` — personal repo URL in generated README | Info | Only appears in generated documentation text, not a functional URL |
| `src/cli/commands/system-commands.ts` | 329 | `aof/aof` placeholder URL in self-update download | Warning | Pre-existing (pre-phase-06). Would cause self-update command to fail at runtime, but not part of phase 06 scope |

No blocker anti-patterns in phase 06 deliverables.

---

## Human Verification Required

### 1. End-to-End Fresh Install

**Test:** On a clean machine with Node >= 22 and OpenClaw installed, run:
`curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh`
**Expected:** AOF installs to `~/.aof`, all directories created (`tasks/`, `org/`, `memory/`, `state/`, `logs/`, etc.), OpenClaw plugin registered, summary printed with "AOF v{X} installed successfully!", `aof task create "test"` works immediately
**Why human:** Cannot execute a real curl-pipe install or invoke the openclaw CLI binary in static verification

### 2. Node Version Rejection

**Test:** On a machine with Node 18 or 20, run the install script
**Expected:** "Node.js >= 22 required (found v18.x.x)" printed to stderr, script exits 1, no files created or modified
**Why human:** Requires a real shell environment with a lower Node version

### 3. Idempotent Upgrade Without Data Loss

**Test:** Install AOF once, create a task (`aof task create "important task"`), run the installer again
**Expected:** Task file preserved in `~/.aof/tasks/`, `.version` file updated to new version, "Upgraded from v{old} to v{new}" shown in summary
**Why human:** Requires a live two-pass install scenario to verify the backup/restore cycle preserves user data

---

## Gaps Summary

No gaps. All automated checks passed: TypeScript compiles without errors, all 10 updater tests pass (including the new `extractTarball` integration test), `install.sh` passes POSIX syntax check, all 6 requirement IDs are covered, all 8 key links are wired, and no blocker anti-patterns exist in phase 06 files.

The only items requiring human validation are the live end-to-end scenarios that cannot be verified statically.

---

_Verified: 2026-02-26T18:23:58Z_
_Verifier: Claude (gsd-verifier)_
