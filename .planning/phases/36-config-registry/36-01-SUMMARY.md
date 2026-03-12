---
phase: 36-config-registry
plan: 01
subsystem: config
tags: [zod, config-registry, singleton, validation, env-vars]

# Dependency graph
requires: []
provides:
  - "Zod-validated config registry singleton (getConfig, resetConfig, ConfigError)"
  - "AofConfigSchema covering core, dispatch, daemon, openclaw, integrations domains"
  - "Renamed org-chart-config.ts with updated barrel exports"
affects: [36-02, 37-structured-logging, 38-code-refactoring]

# Tech tracking
tech-stack:
  added: []
  patterns: [lazy-singleton-with-deep-freeze, env-to-schema-mapping, levenshtein-typo-detection]

key-files:
  created:
    - src/config/registry.ts
    - src/config/__tests__/registry.test.ts
  modified:
    - src/config/index.ts
    - src/config/org-chart-config.ts (renamed from manager.ts)
    - src/config/__tests__/org-chart-config.test.ts (renamed from manager.test.ts)

key-decisions:
  - "Used z.coerce.number() for numeric env vars since process.env values are always strings"
  - "Levenshtein distance for unknown AOF_* var suggestions with half-length threshold"
  - "resetConfig(overrides) deep-merges with Zod defaults without reading process.env"

patterns-established:
  - "Lazy singleton: module-scoped cache with getConfig()/resetConfig() pattern"
  - "Env-to-schema mapping: readEnvInput() strips undefined values so Zod defaults apply"
  - "Deep freeze: recursive Object.freeze on config result for immutability"

requirements-completed: [CFG-01, CFG-02, CFG-04]

# Metrics
duration: 3min
completed: 2026-03-12
---

# Phase 36 Plan 01: Config Registry Summary

**Zod-validated config registry singleton with 5 nested domains, deep freeze, test isolation via resetConfig, and unknown env var typo detection**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-12T23:22:42Z
- **Completed:** 2026-03-12T23:25:20Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Created config registry with lazy-initialized, Zod-validated, deeply frozen singleton
- ConfigError reports ALL validation failures at once with Zod issue paths
- resetConfig() enables complete test isolation with partial override deep-merge
- Unknown AOF_* env var detection with Levenshtein closest-match suggestion
- Renamed manager.ts to org-chart-config.ts, updated barrel with registry exports
- 22 config tests pass (14 registry + 8 org-chart-config)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create config registry with Zod schema and test suite** - `327bab2` (test: RED), `b651334` (feat: GREEN)
2. **Task 2: Rename manager.ts to org-chart-config.ts and update barrel exports** - `36e0aac` (refactor)

## Files Created/Modified
- `src/config/registry.ts` - Zod-validated config registry singleton with getConfig/resetConfig/ConfigError
- `src/config/__tests__/registry.test.ts` - 14 unit tests covering all registry behaviors
- `src/config/index.ts` - Updated barrel exporting both org-chart-config and registry modules
- `src/config/org-chart-config.ts` - Renamed from manager.ts (no content changes)
- `src/config/__tests__/org-chart-config.test.ts` - Renamed from manager.test.ts, updated import path

## Decisions Made
- Used `z.coerce.number()` for all numeric env vars (process.env values are always strings)
- Levenshtein distance threshold set to half key length for typo suggestions
- `resetConfig(overrides)` parses Zod defaults then deep-merges overrides, skipping process.env entirely
- `stripUndefined()` helper ensures unset env vars don't override Zod defaults with undefined
- AOF_DATA_DIR takes precedence over AOF_ROOT; AOF_VAULT_ROOT takes precedence over OPENCLAW_VAULT_ROOT

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Test for CFG-04 import check used incorrect relative URL (`../../registry.ts` instead of `../registry.ts`) -- fixed during GREEN phase.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Registry singleton ready for Plan 02 to wire all 15 process.env reads through getConfig()
- Barrel exports complete -- consumers can import from `config/index.ts`
- paths.ts resolveDataDir() still reads process.env directly -- Plan 02 will update it

## Self-Check: PASSED

All 5 files verified present. All 3 task commits verified in git log.

---
*Phase: 36-config-registry*
*Completed: 2026-03-12*
