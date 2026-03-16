---
phase: 38-code-refactoring
plan: 03
subsystem: tools
tags: [tool-registry, permissions, zod, higher-order-function, mcp, openclaw]

requires:
  - phase: 37-structured-logging
    provides: "Structured logging infrastructure (Pino) used by tool handlers"
provides:
  - "Shared toolRegistry map with ToolDefinition interface for all 11 AOF tools"
  - "withPermissions() HOF for wrapping tool handlers with actor/project extraction"
  - "Co-located Zod schemas in domain tool modules"
  - "Thin MCP registration loop consuming tool-registry"
  - "Slimmed OpenClaw adapter looping over handler map with withPermissions"
affects: [tool-registration, mcp-adapter, openclaw-adapter, new-tool-onboarding]

tech-stack:
  added: [zod-to-json-schema]
  patterns: [shared-tool-registry, withPermissions-HOF, co-located-schemas, registry-loop-registration]

key-files:
  created:
    - src/tools/tool-registry.ts
    - src/openclaw/permissions.ts
    - src/tools/__tests__/tool-registry.test.ts
    - src/openclaw/__tests__/permissions.test.ts
  modified:
    - src/mcp/tools.ts
    - src/openclaw/adapter.ts
    - src/tools/project-tools.ts
    - src/tools/task-crud-tools.ts
    - src/tools/task-workflow-tools.ts
    - src/tools/query-tools.ts
    - src/tools/context-tools.ts
    - src/tools/aof-tools.ts

key-decisions:
  - "MCP-specific handlers (dispatch, task_update, task_complete) kept separate due to significant extra behavior (workflow resolution, subscribe-at-dispatch, body building)"
  - "Used zod-to-json-schema for OpenClaw JSON Schema generation from co-located Zod schemas"
  - "aof_context_load included in shared registry despite needing adapter-level context extras"

patterns-established:
  - "Shared tool registry pattern: define once in src/tools/tool-registry.ts, both adapters consume via loop"
  - "withPermissions HOF: extracts actor/project, resolves permission-aware store, wraps result in content array"
  - "Co-located schemas: Zod schemas live in domain tool modules (project-tools, task-crud-tools, etc.)"

requirements-completed: [REF-03, REF-07, REF-08]

duration: 7min
completed: 2026-03-13
---

# Phase 38 Plan 03: Tool Registration Unification Summary

**Shared tool-registry with 11 tools, withPermissions() HOF eliminating 20 `as any` casts, OpenClaw adapter reduced 63% (619->230 lines)**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-13T11:51:21Z
- **Completed:** 2026-03-13T11:58:33Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments
- Created shared tool-registry.ts with ToolDefinition interface and toolRegistry map covering all 11 shared AOF tools
- Co-located Zod schemas from MCP tools.ts into their domain tool modules (project-tools, task-crud-tools, task-workflow-tools, query-tools, context-tools)
- Created withPermissions() HOF that eliminates all `(params as any)` casts in OpenClaw adapter
- Rewrote OpenClaw adapter.ts to register shared tools via registry loop (619 -> 230 lines, 63% reduction)
- Rewrote MCP tools.ts to use registry loop for simple tools while keeping MCP-specific handlers (670 -> 435 lines, 35% reduction)
- All 197 tests pass across 23 test files with zero type errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Create tool-registry and withPermissions, co-locate schemas** - `15b748d` (feat, TDD)
2. **Task 2: Slim MCP tools.ts and OpenClaw adapter.ts to use registry** - `68a661c` (feat)
3. **Barrel re-export** - `68ebd59` (chore)

## Files Created/Modified
- `src/tools/tool-registry.ts` - Shared handler map with ToolDefinition interface and toolRegistry export (11 tools)
- `src/openclaw/permissions.ts` - withPermissions() HOF for wrapping handlers with actor/project extraction
- `src/tools/__tests__/tool-registry.test.ts` - Tests verifying all expected tools present with schema+handler+description
- `src/openclaw/__tests__/permissions.test.ts` - Tests for withPermissions store resolution and result wrapping
- `src/mcp/tools.ts` - Thin registration using registry loop for shared tools + MCP-specific handlers
- `src/openclaw/adapter.ts` - Slimmed adapter looping over toolRegistry with withPermissions + zodToJsonSchema
- `src/tools/project-tools.ts` - Added co-located dispatchSchema
- `src/tools/task-crud-tools.ts` - Added co-located taskUpdateSchema, taskEditSchema, taskCancelSchema
- `src/tools/task-workflow-tools.ts` - Added co-located taskCompleteSchema, taskDepAdd/Remove, taskBlock/Unblock schemas
- `src/tools/query-tools.ts` - Added co-located statusReportSchema
- `src/tools/context-tools.ts` - Added co-located contextLoadSchema
- `src/tools/aof-tools.ts` - Re-exports toolRegistry from barrel module

## Decisions Made
- **MCP-specific handlers kept separate:** dispatch, task_update, task_complete have significant extra behavior (workflow resolution, subscribe-at-dispatch, body building with workLog/outputs) that the base tool functions do not handle. These remain as MCP-specific handlers.
- **Used zod-to-json-schema:** The OpenClaw adapter uses this (already available as transitive dependency) to convert co-located Zod schemas to JSON Schema for OpenClaw's parameter format.
- **aof_context_load in registry:** Included in the shared registry even though it needs adapter-specific context extras (registry, skillsDir), using a duck-typed extension on ToolContext.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Tool registration is now unified: adding a new tool means implementing it in src/tools/ with a co-located schema and adding it to tool-registry.ts
- Both MCP and OpenClaw adapters automatically pick up new tools through their registry loops
- Ready for phases 39 (Architecture Fixes) and 40 (Test Infrastructure)

---
*Phase: 38-code-refactoring*
*Completed: 2026-03-13*
