---
phase: 39-architecture-fixes
plan: 02
subsystem: architecture
tags: [circular-deps, dependency-inversion, module-layering, barrel-files, madge]

requires:
  - phase: 38-code-refactoring
    provides: extracted handlers and modular dispatch structure
provides:
  - 5 simple A-B circular dependency cycles eliminated
  - config/ layer isolated from domain modules via dependency inversion
  - createProjectStore relocated from CLI to projects/ layer
  - loadProjectManifest unified in projects/manifest.ts
  - memory/index.ts split into pure barrel + register.ts
  - ARCHITECTURE.md documenting import direction rules
affects: [39-architecture-fixes, testing]

tech-stack:
  added: []
  patterns: [dependency-inversion-for-config, type-extraction-for-cycles, pure-barrel-pattern]

key-files:
  created:
    - src/org/types.ts
    - src/projects/types.ts
    - src/context/types.ts
    - src/projects/store-factory.ts
    - src/memory/register.ts
    - ARCHITECTURE.md
  modified:
    - src/config/registry.ts
    - src/config/org-chart-config.ts
    - src/org/linter.ts
    - src/org/linter-helpers.ts
    - src/store/interfaces.ts
    - src/store/task-store.ts
    - src/store/task-lifecycle.ts
    - src/store/task-mutations.ts
    - src/store/index.ts
    - src/projects/lint.ts
    - src/projects/lint-helpers.ts
    - src/projects/manifest.ts
    - src/projects/index.ts
    - src/context/assembler.ts
    - src/context/manifest.ts
    - src/dispatch/assign-executor.ts
    - src/mcp/shared.ts
    - src/cli/project-utils.ts
    - src/cli/commands/config-commands.ts
    - src/memory/index.ts
    - src/delegation/index.ts

key-decisions:
  - "Inlined normalizePath in registry.ts to break config/paths<->registry cycle (simpler than extracting to config/utils.ts)"
  - "Used dependency inversion for config->org: linter passed as optional parameter to setConfigValue/validateConfig"
  - "createProjectStore re-exported from cli/project-utils.ts for backward compatibility"
  - "loadProjectManifest uses structured logging (createLogger) in projects/manifest.ts canonical implementation"

patterns-established:
  - "Type extraction pattern: shared types in sibling types.ts to break A-B cycles"
  - "Dependency inversion: config/ accepts callbacks rather than importing domain modules"
  - "Pure barrel pattern: index.ts files contain only re-exports, no function definitions"

requirements-completed: [ARCH-03, ARCH-04, ARCH-05, ARCH-06]

duration: 12min
completed: 2026-03-13
---

# Phase 39 Plan 02: Architecture Fixes Summary

**Eliminated all 17 circular dependencies (5 simple A-B + 12 complex) via type extraction and dependency inversion, unified loadProjectManifest, split memory barrel, documented layering rules in ARCHITECTURE.md**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-13T20:48:44Z
- **Completed:** 2026-03-13T21:01:42Z
- **Tasks:** 2
- **Files modified:** 22

## Accomplishments
- Eliminated all 5 simple A-B circular dependency cycles by extracting shared types to dedicated types.ts files
- Fixed config->org upward import via dependency inversion (linter passed as parameter)
- Moved createProjectStore from CLI layer to projects/ so MCP no longer depends on CLI
- Unified duplicate loadProjectManifest implementations into single projects/manifest.ts
- Split memory/index.ts (348 lines) into pure 30-line barrel + register.ts
- Created ARCHITECTURE.md documenting import direction rules and module layering
- All 17 circular dependencies resolved (madge reports 0 cycles across entire src/)

## Task Commits

Each task was committed atomically:

1. **Task 1: Break 5 simple A-B cycles via type extraction** - `189134a` (refactor)
2. **Task 2: Fix layering violations, relocate modules, split memory barrel, document import rules** - `beb4624` (feat)

## Files Created/Modified
- `src/org/types.ts` - Shared LintIssue type for org module
- `src/projects/types.ts` - Shared LintIssue/LintResult types for projects module
- `src/context/types.ts` - Shared ContextManifest type for context module
- `src/projects/store-factory.ts` - createProjectStore relocated from CLI layer
- `src/memory/register.ts` - registerMemoryModule and all helper logic extracted from barrel
- `ARCHITECTURE.md` - Import direction rules and module layering constraints
- `src/config/registry.ts` - Inlined normalizePath to break paths<->registry cycle
- `src/config/org-chart-config.ts` - Dependency inversion: linter parameter replaces org/ import
- `src/store/interfaces.ts` - TaskStoreHooks moved here from task-store.ts
- `src/dispatch/assign-executor.ts` - loadProjectManifest re-exported from projects/manifest.ts
- `src/mcp/shared.ts` - Imports createProjectStore from projects/store-factory.ts
- `src/memory/index.ts` - Pure barrel (30 lines, zero function definitions)

## Decisions Made
- Inlined normalizePath in registry.ts rather than creating config/utils.ts (simpler, single usage)
- Used dependency inversion for config->org: linter is an optional parameter so config/ has zero domain imports
- Re-exported createProjectStore from cli/project-utils.ts for backward compatibility
- loadProjectManifest uses createLogger("projects:manifest") for consistent structured logging

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test expecting lint issues without linter**
- **Found during:** Task 2 (ARCH-03 dependency inversion)
- **Issue:** org-chart-config.test.ts called setConfigValue without linter parameter, test expected issues.length > 0
- **Fix:** Updated test to pass lintOrgChart as linter parameter
- **Files modified:** src/config/__tests__/org-chart-config.test.ts
- **Verification:** Test passes with linter injected
- **Committed in:** beb4624

**2. [Rule 1 - Bug] Fixed duplicate TaskStoreHooks in task-mutations.ts**
- **Found during:** Task 1 (store cycle fix)
- **Issue:** TaskStoreHooks was defined in both task-store.ts and task-mutations.ts
- **Fix:** Both now import/re-export from interfaces.ts
- **Files modified:** src/store/task-mutations.ts
- **Committed in:** 189134a

**3. [Rule 1 - Bug] Fixed delegation/index.ts importing TaskStoreHooks from task-store.ts**
- **Found during:** Task 1 (store cycle fix)
- **Issue:** delegation/index.ts still imported TaskStoreHooks from old location
- **Fix:** Updated import to use store/interfaces.ts
- **Files modified:** src/delegation/index.ts
- **Committed in:** 189134a

---

**Total deviations:** 3 auto-fixed (3 bugs)
**Impact on plan:** All fixes necessary for correctness. No scope creep.

## Issues Encountered
- .gitignore `org/` pattern matches `src/org/` requiring `git add -f` for new files in that directory
- Background linter/formatter reverted changes to org-chart-config.ts once; re-applied successfully

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All circular dependencies eliminated (0 cycles reported by madge)
- Module layering rules documented in ARCHITECTURE.md
- Plan 03 (complex dispatch cycles) can proceed -- dispatch/ cycles were resolved as a side effect of the type extraction approach

---
*Phase: 39-architecture-fixes*
*Completed: 2026-03-13*
