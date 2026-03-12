---
phase: 36-config-registry
plan: 02
subsystem: config
tags: [zod, config-registry, env-consolidation, process-env]

# Dependency graph
requires:
  - phase: 36-01
    provides: Config registry singleton (getConfig, resetConfig, AofConfigSchema)
provides:
  - All process.env reads consolidated through config registry
  - CLAWDBOT_STATE_DIR dead code removed
  - Single source of truth for environment configuration
affects: [37-structured-logging, 38-code-refactoring]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "getConfig() lazy call inside function bodies (never module-level)"
    - "resetConfig() in test beforeEach/afterEach for config isolation"

key-files:
  created: []
  modified:
    - src/config/paths.ts
    - src/projects/resolver.ts
    - src/daemon/standalone-adapter.ts
    - src/openclaw/openclaw-executor.ts
    - src/memory/index.ts
    - src/cli/program.ts
    - src/cli/commands/memory.ts
    - src/daemon/index.ts
    - src/mcp/server.ts
    - src/projects/__tests__/resolver.test.ts

key-decisions:
  - "Lazy default for --root CLI option via preAction hook instead of module-level const"
  - "configPath fallback uses cfg.openclaw.stateDir + openclaw.json instead of hardcoded homedir path"

patterns-established:
  - "Config access: always call getConfig() inside function bodies, never at module top level"
  - "Test isolation: use resetConfig() in beforeEach/afterEach when testing config-dependent modules"

requirements-completed: [CFG-03]

# Metrics
duration: 4min
completed: 2026-03-12
---

# Phase 36 Plan 02: Env Consolidation Summary

**All 9 source files migrated from direct process.env reads to config registry, achieving zero stray env access outside src/config/ and documented exception files**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-12T23:28:00Z
- **Completed:** 2026-03-12T23:32:20Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- 9 source files migrated from process.env to getConfig() calls
- CLAWDBOT_STATE_DIR dead legacy fallback removed from openclaw-executor.ts
- Zero stray process.env reads outside src/config/ and documented AOF_CALLBACK_DEPTH exceptions
- Full test suite passes (254 files, 2939 tests) with no regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Migrate config/ and core module process.env reads to registry** - `721bd20` (feat)
2. **Task 2: Migrate CLI and daemon entrypoint process.env reads to registry** - `c324f4d` (feat)

## Files Created/Modified
- `src/config/paths.ts` - resolveDataDir() now uses getConfig().core.dataDir
- `src/projects/resolver.ts` - resolveProject() uses getConfig().core.dataDir
- `src/daemon/standalone-adapter.ts` - Constructor uses getConfig().openclaw for gateway URL/token
- `src/openclaw/openclaw-executor.ts` - resolveGatewayDistDir() uses getConfig().openclaw.stateDir
- `src/memory/index.ts` - OPENAI_API_KEY sourced from getConfig().integrations.openaiApiKey
- `src/cli/program.ts` - --root default lazily resolved via getConfig() in preAction hook
- `src/cli/commands/memory.ts` - vault root and config path use getConfig().core/openclaw
- `src/daemon/index.ts` - AOF_ROOT and AOF_DAEMON_SOCKET replaced with getConfig()
- `src/mcp/server.ts` - AOF_ROOT replaced with getConfig().core.dataDir
- `src/projects/__tests__/resolver.test.ts` - Added resetConfig() for test isolation

## Decisions Made
- Lazy default for --root CLI option via preAction hook instead of module-level const, avoiding early getConfig() call at import time
- configPath fallback in memory audit command uses cfg.openclaw.stateDir + "openclaw.json" instead of hardcoded homedir path, keeping it consistent with registry defaults

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed resolver test isolation with resetConfig()**
- **Found during:** Task 1
- **Issue:** Resolver test "falls back to ~/.aof when no vaultRoot or env" failed because getConfig() was cached from a prior test that set AOF_ROOT
- **Fix:** Added resetConfig() calls in beforeEach/afterEach to clear cached config between tests
- **Files modified:** src/projects/__tests__/resolver.test.ts
- **Verification:** All 5 resolver tests pass
- **Committed in:** 721bd20 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Essential fix for test correctness. No scope creep.

## Issues Encountered
None beyond the test isolation fix documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Config registry is now the single source of truth for all environment configuration
- CFG-03 requirement fully satisfied
- Phase 36 complete, ready for Phase 37 (Structured Logging)

---
*Phase: 36-config-registry*
*Completed: 2026-03-12*
