---
phase: 05-ci-pipeline
plan: 02
subsystem: infra
tags: [github-actions, release, tarball, ci-cd]

# Dependency graph
requires:
  - phase: 05-ci-pipeline/01
    provides: CI validation workflow (typecheck/build/test on PR)
provides:
  - Tag-triggered release workflow (.github/workflows/release.yml)
  - Production tarball build script (scripts/build-tarball.mjs)
affects: [installer, release]

# Tech tracking
tech-stack:
  added: [softprops/action-gh-release@v2]
  patterns: [tag-triggered-workflow, staging-directory-tarball-build]

key-files:
  created:
    - scripts/build-tarball.mjs
    - .github/workflows/release.yml
  modified: []

key-decisions:
  - "Node 22 only for release builds (no matrix -- LTS pinned)"
  - "cancel-in-progress: false for release workflow (runs must always complete)"
  - "LICENSE is optional in tarball (try/catch skip if missing)"

patterns-established:
  - "Tarball build: staging directory + tar -czf + cleanup pattern"
  - "Release workflow: validate first (typecheck, build, test) then package + upload"

requirements-completed: [CI-03]

# Metrics
duration: 2min
completed: 2026-02-26
---

# Phase 5 Plan 2: Release Workflow Summary

**Tag-triggered GitHub Actions release workflow with production tarball builder using softprops/action-gh-release@v2**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-26T17:01:35Z
- **Completed:** 2026-02-26T17:03:11Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Production tarball build script that mirrors package.json "files" field, validates required files, and handles optional LICENSE
- Release workflow triggered by v* tag push that runs full validation (typecheck, build, test) before building and uploading tarball
- Tarball attached to existing GitHub Release created by local release-it run via softprops/action-gh-release@v2

## Task Commits

Each task was committed atomically:

1. **Task 1: Create tarball build script** - `62b5e9d` (feat)
2. **Task 2: Create release workflow** - `6cdd974` (feat)

## Files Created/Modified
- `scripts/build-tarball.mjs` - ESM Node.js script that assembles production files into aof-v{version}.tar.gz tarball
- `.github/workflows/release.yml` - Tag-triggered release workflow: validate, build tarball, upload to GitHub Release

## Decisions Made
- Node 22 only for release builds -- no matrix needed since release-it targets a single LTS version
- cancel-in-progress: false on release concurrency group -- release runs must always complete to avoid partial artifacts
- LICENSE treated as optional in tarball (try/catch) since it may not exist yet in the repo

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 5 CI Pipeline is fully complete (both ci.yml and release.yml workflows in place)
- Release workflow depends on release-it pushing v* tags (already configured in package.json scripts)
- Phase 6 Installer can now download tarballs produced by this release workflow

## Self-Check: PASSED

All files and commits verified:
- scripts/build-tarball.mjs: FOUND
- .github/workflows/release.yml: FOUND
- 05-02-SUMMARY.md: FOUND
- Commit 62b5e9d: FOUND
- Commit 6cdd974: FOUND

---
*Phase: 05-ci-pipeline*
*Completed: 2026-02-26*
