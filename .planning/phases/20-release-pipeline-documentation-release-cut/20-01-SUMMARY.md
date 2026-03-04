---
phase: 20-release-pipeline-documentation-release-cut
plan: 01
subsystem: infra
tags: [ci, release-pipeline, verify-tarball, upgrading, documentation]

# Dependency graph
requires:
  - phase: 19-verification-smoke-tests
    provides: verify-tarball.mjs script and aof smoke command
provides:
  - Verify-tarball gate in CI release pipeline
  - UPGRADING.md with fresh install, v1.2 upgrade, and pre-v1.2 upgrade paths
  - Repository ready for v1.3.0 release cut
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CI gate pattern: verification step between build and upload blocks bad releases"

key-files:
  created:
    - UPGRADING.md
  modified:
    - .github/workflows/release.yml

key-decisions:
  - "Single verify step in CI -- no separate aof smoke in pipeline"
  - "UPGRADING.md at repo root covers all three upgrade paths with rollback documentation"

patterns-established:
  - "Release pipeline gate: verify-tarball.mjs runs between build and upload, exits non-zero to block"

requirements-completed: [RELS-01, RELS-02, RELS-03]

# Metrics
duration: 4min
completed: 2026-03-04
---

# Phase 20 Plan 01: Release Pipeline, Documentation & Release Cut Summary

**Verify-tarball CI gate wired into release.yml, UPGRADING.md written with all v1.3 upgrade paths and rollback instructions**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-04T02:15:52Z
- **Completed:** 2026-03-04T02:20:00Z
- **Tasks:** 2 of 3 (Task 3 is a human-verify checkpoint)
- **Files modified:** 2

## Accomplishments
- Inserted verify-tarball.mjs step between build and upload in release.yml -- bad tarballs now block release
- Created UPGRADING.md (185 lines) covering fresh install, v1.2 upgrade, pre-v1.2 upgrade, verification with aof smoke, and rollback via snapshots and installer backups

## Task Commits

Each task was committed atomically:

1. **Task 1: Add verify-tarball gate to release pipeline** - `20af5f9` (feat)
2. **Task 2: Write UPGRADING.md for v1.3** - `2bb1e1f` (docs)
3. **Task 3: Verify pipeline and docs, then cut v1.3.0 release** - checkpoint:human-verify (awaiting human review)

## Files Created/Modified
- `.github/workflows/release.yml` - Added verify-tarball step between build and upload
- `UPGRADING.md` - New user-facing upgrade documentation for v1.3

## Decisions Made
- Single verify-tarball.mjs step in CI is sufficient -- no separate aof smoke in pipeline (per user decision)
- UPGRADING.md placed at repo root alongside README.md, targeted at tool users not contributors
- Documented both rollback mechanisms (migration snapshots and installer backups) with manual restore steps since no aof rollback CLI exists yet

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All CI and documentation artifacts are ready
- Human review at Task 3 checkpoint: review release.yml placement and UPGRADING.md content
- After review: run `npm run release:dry` then `npm run release -- 1.3.0` to cut v1.3.0

---
*Phase: 20-release-pipeline-documentation-release-cut*
*Completed: 2026-03-04*
