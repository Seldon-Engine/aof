# Phase 34: Dead Code Removal - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Remove ~2,900 lines of deprecated gate system code (source + tests + barrel re-exports + lazy migration), unused imports/exports/schemas, deprecated type aliases, and commented-out code. Pure subtraction — no new code written.

</domain>

<decisions>
## Implementation Decisions

### Migration safety
- No pre-removal scan for gate-format tasks — just remove the lazy migration code
- v1.3 shipped months ago; any gate tasks would have been migrated through normal reads by now
- The migration code in task-store.ts (get, getByPrefix, list) and migration/gate-to-dag.ts is removed outright

### Removal strategy
- Incremental commits by category for bisect-ability:
  1. Gate source files (gate-evaluator.ts, gate-conditional.ts, gate-context-builder.ts, gate.ts schema, workflow.ts schema)
  2. Gate test files (gate-evaluator.test.ts, gate-enforcement.test.ts, gate-conditional.test.ts, gate-context-builder.test.ts, gate-timeout.test.ts, gate.test.ts, task-gate-extensions.test.ts)
  3. Barrel re-exports from schemas/index.ts and dispatch/index.ts
  4. Lazy gate-to-DAG migration code from task-store.ts and migration/gate-to-dag.ts
  5. Unused imports in scheduler.ts (18+ symbols)
  6. Unused MCP output schemas (13 schemas in mcp/tools.ts)
  7. Deprecated type aliases (DispatchResult, Executor, MockExecutor) + commented-out code + deprecated notifier param
- Each commit should leave the codebase in a compiling, test-passing state

### Claude's Discretion
- Exact ordering within categories (which files first)
- Whether to combine small related deletions within a category
- How to handle any unexpected compile errors from removal cascades

</decisions>

<specifics>
## Specific Ideas

No specific requirements — this is mechanical deletion guided by the codebase analysis reports in `.planning/codebase/CONCERNS.md` and `.planning/codebase/QUALITY.md`.

</specifics>

<code_context>
## Existing Code Insights

### Files to Remove (from CONCERNS.md analysis)
- `src/schemas/gate.ts` — gate schema types (~100 lines)
- `src/schemas/workflow.ts` — WorkflowConfig, RejectionStrategy (~100 lines)
- `src/dispatch/gate-evaluator.ts` — evaluateGateTransition (365 lines)
- `src/dispatch/gate-conditional.ts` — evaluateGateCondition (165 lines)
- `src/dispatch/gate-context-builder.ts` — buildGateContext (239 lines)
- Gate test files (~2,000 lines total across 7 test files)

### Imports to Clean (from CONCERNS.md analysis)
- `src/dispatch/scheduler.ts` lines 8-27: 18+ unused imports from prior module extractions
- `src/dispatch/assign-executor.ts` lines 150-169: gate context injection still active
- `src/dispatch/escalation.ts`: checkGateTimeouts() runs on every poll cycle

### Barrel Re-exports to Remove
- `src/schemas/index.ts` lines 94-101: gate type re-exports
- `src/dispatch/index.ts` lines 11-18: gate module re-exports

### Integration Points
- `src/store/task-store.ts` lines 251-258, 292-298, 343-352: lazy migration blocks in get/getByPrefix/list
- `src/migration/gate-to-dag.ts`: migration utility (may be removable if no other callers)

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 34-dead-code-removal*
*Context gathered: 2026-03-12*
