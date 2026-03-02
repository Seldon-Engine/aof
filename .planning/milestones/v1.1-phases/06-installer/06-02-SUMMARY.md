---
phase: 06-installer
plan: 02
subsystem: installer
tags: [curl-pipe, posix-shell, setup-wizard, openclaw-plugin, migration]

# Dependency graph
requires:
  - phase: 06-installer plan 01
    provides: Real GITHUB_REPO constant, working extractTarball(), package-lock.json in tarball
  - phase: 05-ci
    provides: Build tarball script and release workflow
provides:
  - POSIX install.sh for curl-pipe installation
  - Node.js `aof setup` command for post-extraction orchestration
  - Wizard scaffolds full AOF home directories (memory, state, logs)
  - OpenClaw plugin wiring with health check and rollback
  - Upgrade path with data backup/restore and migration framework
  - Legacy install detection and data migration from ~/.openclaw/aof/
affects: [end-user installation, self-update flow, OpenClaw integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [POSIX shell main() wrapper for curl-pipe safety, trap-based cleanup, Node.js CLI orchestrator pattern]

key-files:
  created:
    - scripts/install.sh
    - src/cli/commands/setup.ts
  modified:
    - src/cli/index.ts
    - src/packaging/wizard.ts

key-decisions:
  - "Uses d0labs/aof GitHub repository for all download URLs and API calls"
  - "install.sh delegates complex logic (wizard, migrations, wiring) to Node.js setup command"
  - "OpenClaw plugin wiring is soft: installs AOF even without OpenClaw, skips wiring with warning"
  - "Plugin wiring uses openclaw-cli.ts config commands, never direct JSON editing"
  - "Wizard scaffolds memory/, state/, logs/ for full AOF data home at ~/.aof"
  - "Legacy data migration copies (not moves) from ~/.openclaw/aof/ for implicit backup"

patterns-established:
  - "Shell entry + Node.js orchestrator: install.sh handles download/extract, setup.ts handles logic"
  - "Soft requirement pattern: detect -> wire if found -> warn and continue if not"
  - "Plugin health check with rollback: verify after wiring, undo config on failure"

requirements-completed: [INST-01, INST-03, INST-04, INST-05]

# Metrics
duration: 4min
completed: 2026-02-26
---

# Phase 6 Plan 2: Installer Pipeline Summary

**POSIX install.sh entry point with Node.js setup orchestrator for curl-pipe installation, upgrade-safe data backup, and OpenClaw plugin wiring**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-26T18:15:29Z
- **Completed:** 2026-02-26T18:19:26Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- POSIX-compatible install.sh handles prerequisite checks (Node >= 22, tar, curl/wget), GitHub release resolution, tarball download/extraction, and npm ci -- fully automatic with zero prompts
- Node.js `aof setup` command orchestrates fresh install (wizard scaffolding), upgrade (migrations), legacy data migration, and OpenClaw plugin wiring
- Wizard now scaffolds memory/, state/, logs/ directories and .gitignore includes *.db, *.dat patterns for full AOF data home
- Plugin wiring uses openclaw-cli.ts with health check and rollback on failure

## Task Commits

Each task was committed atomically:

1. **Task 1: Create install.sh POSIX shell entry point** - `ebedfd4` (feat)
2. **Task 2: Create Node.js setup command and update wizard defaults** - `25c8edd` (feat)

## Files Created/Modified
- `scripts/install.sh` - POSIX shell entry point for curl-pipe installation with main() wrapper, prerequisite checks, download/extract, data backup for upgrades
- `src/cli/commands/setup.ts` - Node.js setup orchestrator with fresh/upgrade/legacy flows and OpenClaw plugin wiring
- `src/cli/index.ts` - Registered setup command in CLI entrypoint
- `src/packaging/wizard.ts` - Added memory/, state/, logs/ directories and updated .gitignore patterns

## Decisions Made
- Uses `d0labs/aof` as the GitHub repository (per user correction, NOT demerzel-ops/aof)
- install.sh parses GitHub release JSON with sed/grep to avoid jq dependency
- Legacy data migration copies files (not moves) so originals serve as implicit backup
- Plugin wiring rolls back config changes (but keeps files installed) on health check failure
- Empty migration registry for now -- framework is in place for future schema changes

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Full installer pipeline is operational: `curl -fsSL <url>/install.sh | sh` handles the entire flow
- Phase 6 (Installer) is now complete with both plans delivered
- Packaging stubs (06-01) and installer pipeline (06-02) together provide end-to-end installation capability

## Self-Check: PASSED

- All 4 source files verified present on disk
- Commit ebedfd4 verified in git log
- Commit 25c8edd verified in git log
- SUMMARY.md verified present at expected path

---
*Phase: 06-installer*
*Completed: 2026-02-26*
