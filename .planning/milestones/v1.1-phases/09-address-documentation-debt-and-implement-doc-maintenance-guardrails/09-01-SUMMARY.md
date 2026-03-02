---
phase: 09-address-documentation-debt-and-implement-doc-maintenance-guardrails
plan: 01
subsystem: cli, docs
tags: [commander, cli-reference, code-generation, markdown]

# Dependency graph
requires: []
provides:
  - "Exported Commander program object (src/cli/program.ts) for tooling import"
  - "CLI doc generator script (scripts/generate-cli-docs.mjs)"
  - "Auto-generated CLI reference (docs/guide/cli-reference.md)"
  - "npm run docs:generate script"
affects: [09-04-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns: ["CLI entrypoint split: program.ts (registration) + index.ts (execution)"]

key-files:
  created:
    - src/cli/program.ts
    - scripts/generate-cli-docs.mjs
    - docs/guide/cli-reference.md
  modified:
    - src/cli/index.ts
    - package.json

key-decisions:
  - "Split CLI into program.ts (exports Commander program) and index.ts (thin parseAsync entrypoint) for tooling importability"
  - "Generator walks Commander tree recursively to produce markdown with TOC, arguments tables, and options tables"
  - "70 command sections generated covering all command groups (daemon, task, memory, org, config, metrics, etc.)"

patterns-established:
  - "CLI program export: import { program } from src/cli/program.ts for tooling that needs the command tree"
  - "Doc generation: npm run docs:generate regenerates CLI reference from live Commander tree"

requirements-completed: [DOC-04]

# Metrics
duration: 4min
completed: 2026-02-26
---

# Phase 9 Plan 01: CLI Doc Generator Summary

**Separated CLI program registration from execution and built a Commander-tree-walking doc generator producing a 70-section markdown CLI reference**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-27T01:59:48Z
- **Completed:** 2026-02-27T02:03:23Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Refactored CLI entrypoint into `program.ts` (all command registration, exported) and `index.ts` (thin 4-line parseAsync wrapper)
- Built `scripts/generate-cli-docs.mjs` that recursively walks Commander command tree and emits markdown with TOC, arguments tables, and options tables
- Generated `docs/guide/cli-reference.md` with 70 command sections covering all registered commands and subcommands
- Added `npm run docs:generate` script for on-demand reference regeneration

## Task Commits

Each task was committed atomically:

1. **Task 1: Refactor CLI entrypoint** - `f33cd6a` (refactor)
2. **Task 2: Build CLI doc generator** - `b713691` (feat)

## Files Created/Modified
- `src/cli/program.ts` - Exported Commander program with all commands registered (new)
- `src/cli/index.ts` - Thin entrypoint: imports program, calls parseAsync (rewritten)
- `scripts/generate-cli-docs.mjs` - CLI doc generator that walks Commander tree and emits markdown (new)
- `docs/guide/cli-reference.md` - Auto-generated CLI reference with 70 command sections (new)
- `package.json` - Added docs:generate script (modified)

## Decisions Made
- Split CLI into program.ts (exports Commander program) and index.ts (thin parseAsync entrypoint) for tooling importability
- Generator uses Commander introspection API (commands, registeredArguments, options) to walk tree recursively
- Generated markdown includes AUTO-GENERATED header comment, table of contents, and per-command sections with arguments and options tables
- 70 command sections produced, covering all command groups: daemon, task, memory, org, config, metrics, channel, install, update, setup, project, lint, scan, scheduler

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `program.ts` export is ready for any future tooling that needs to introspect the Commander tree
- `docs:generate` script is ready for Plan 04's pre-commit hook to use for stale-docs detection
- CLI reference document is complete and ready for the documentation site

## Self-Check: PASSED

All files verified present. All commits verified in git log.

---
*Phase: 09-address-documentation-debt-and-implement-doc-maintenance-guardrails*
*Completed: 2026-02-26*
