# Phase 39: Architecture Fixes - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Clean up module dependency graph — break all circular imports, route all task writes through ITaskStore, fix layering violations (config→org, MCP→CLI), deduplicate loadProjectManifest(), and split memory/index.ts barrel from registration logic.

Scope expanded from roadmap's original "dispatch/protocol cycle" to all 17 circular dependency cycles found by madge (many introduced by Phase 38 handler extractions).

</domain>

<decisions>
## Implementation Decisions

### Circular Dependency Strategy
- Fix ALL 17 circular dependency cycles — not just the original dispatch/protocol cycle
- Target: zero cycles from `madge --circular src/`
- Dispatch handler cycles (scheduler↔action-executor↔handlers): break with extracted shared types/interfaces in dispatch/types.ts or similar — keep Phase 38 decomposition intact
- Tools barrel cycles (aof-tools.ts ↔ sub-modules): fix import direction only — sub-modules import from siblings, not from the barrel
- Other cycles (config/paths↔registry, org/linter↔helpers, store↔lifecycle, context↔manifest, projects/lint↔helpers): extract shared types or fix import direction per cycle

### Store Bypass Approach
- Route ALL 14 bypass sites through ITaskStore — including internal store sub-modules (task-lifecycle.ts, task-deps.ts, task-mutations.ts)
- Add new ITaskStore methods as needed for operations that don't have existing store methods
- External modules (dispatch/) receive ITaskStore via dependency injection (consistent with Phase 35 lock manager pattern)
- After all bypass sites are fixed, restrict exports of serializeTask() and writeFileAtomic() — remove from barrel exports so only store module can use them directly

### Module Relocation
- Fix violations AND document import direction rules (brief section in code or ARCHITECTURE.md — e.g. "config/ must not import from domain modules")
- ARCH-03 (config→org): Invert dependency — org/ calls config/ for validation, not the other way. Config stays at bottom of hierarchy per CFG-04
- ARCH-04 (MCP→CLI): Move createProjectStore() to projects/ module — both MCP and CLI import from projects/
- ARCH-05 (duplicate loadProjectManifest): Unify into projects/ module — consistent with createProjectStore() living there

### Memory Index Split
- Extract registerMemoryModule() and all helpers/types to memory/register.ts
- index.ts becomes a pure barrel file (~30 lines of re-exports)
- Re-export registerMemoryModule from barrel — existing callers don't need import changes

### Claude's Discretion
- Exact naming of extracted type files (dispatch/types.ts, dispatch/interfaces.ts, etc.)
- Per-cycle fix approach for the non-dispatch cycles (type extraction vs import direction fix)
- Which new ITaskStore methods to add vs reusing existing ones
- Format and location of architecture rules documentation

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for dependency graph cleanup.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 35's lock manager pattern: dependency injection of ITaskStore via DispatchConfig — reuse this pattern for store bypass fixes
- Phase 38's tool-registry.ts: already provides shared handler layer — fix its circular imports, don't restructure

### Established Patterns
- Dependency injection via config objects (DispatchConfig, SchedulerConfig) — use for passing ITaskStore to bypass sites
- Barrel files as pure re-export modules (schemas/index.ts pattern) — memory/index.ts should follow this after split
- CFG-04 principle: config module has zero upward dependencies — maintain this invariant

### Integration Points
- dispatch/ modules that bypass store: escalation.ts, dag-transition-handler.ts, failure-tracker.ts
- protocol/router.ts also bypasses store
- store/ internal modules: task-store.ts, task-lifecycle.ts, task-deps.ts, task-mutations.ts
- mcp/shared.ts imports createProjectStore() — will move to projects/
- config/org-chart-config.ts imports from org/linter.ts — dependency to invert

### Madge Scan Results (17 cycles)
1. config/paths.ts ↔ config/registry.ts
2. org/linter.ts ↔ org/linter-helpers.ts
3. store/task-store.ts ↔ store/task-lifecycle.ts
4. dispatch/scheduler.ts → dispatch/action-executor.ts → dispatch/alert-handlers.ts → (back)
5. dispatch/assign-executor.ts → dispatch/assign-helpers.ts → dispatch/task-dispatcher.ts → (back)
6. dispatch/scheduler.ts → action-executor.ts → lifecycle-handlers.ts → assign-executor.ts → scheduler-helpers.ts → (back)
7. dispatch/scheduler.ts → action-executor.ts → lifecycle-handlers.ts → (back)
8. dispatch/scheduler.ts → action-executor.ts → recovery-handlers.ts → (back)
9. dispatch/scheduler.ts → action-executor.ts → (back)
10. dispatch/scheduler.ts → dispatch/escalation.ts → (back)
11. projects/lint.ts ↔ projects/lint-helpers.ts
12. context/assembler.ts ↔ context/manifest.ts
13. tools/aof-tools.ts → tools/project-tools.ts → (back)
14. tools/aof-tools.ts → tools/query-tools.ts → (back)
15. tools/aof-tools.ts → tools/task-tools.ts → tools/task-crud-tools.ts → (back)
16. tools/aof-tools.ts → tools/task-tools.ts → tools/task-workflow-tools.ts → (back)
17. tools/aof-tools.ts → tools/tool-registry.ts → (back)

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 39-architecture-fixes*
*Context gathered: 2026-03-13*
