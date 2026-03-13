# Phase 38: Code Refactoring - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Decompose god functions into testable helpers, unify tool registration between MCP and OpenClaw, deduplicate callback/trace patterns, and split the MCP tools.ts god file. Pure refactoring — no new features, no behavior changes.

</domain>

<decisions>
## Implementation Decisions

### God function decomposition (REF-01, REF-02)
- Extract helpers to **sibling modules** (not same-file): assign-helpers.ts, action-handlers grouped by concern
- executeActions() switch cases grouped into 3-4 handler files by domain (e.g., lifecycle-handlers.ts for assign/expire/promote, dep-handlers.ts for block/unblock/cascade)
- Orchestrator functions (executeAssignAction, executeActions) target **~80 lines max** — orchestration + inline error handling/logging OK, but all business logic in named calls
- Each new sibling module gets its **own test file**. Existing tests remain for integration-level coverage of orchestrators

### Tool registration unification (REF-03)
- **Shared handler map** in `src/tools/` — a tool-registry.ts exports `{toolName: {schema, handler}}` map
- Map includes both **Zod schemas and handler functions** — eliminates schema drift between MCP and OpenClaw
- Handler functions are **framework-agnostic** — return plain results or throw standard errors. MCP and OpenClaw wrappers translate to their framework's error format (McpError codes, OpenClaw error responses)
- Schemas **co-located per handler** — each tool module (task-tools.ts, project-tools.ts) exports schemas alongside handlers
- Both MCP tools.ts and OpenClaw adapter.ts **loop over the handler map** to register tools

### MCP god file split (REF-08)
- mcp/tools.ts becomes **thin registration only** (~50 lines): imports handler map from src/tools/, loops over it, calls server.registerTool() with MCP-specific wrappers (McpError translation, content formatting)
- Inline Zod schemas move to src/tools/ co-located with their handlers
- Handler functions (handleAofDispatch, handleAofTaskComplete, etc.) move to src/tools/ as framework-agnostic implementations

### Callback/trace deduplication (REF-04, REF-05)
- New files in **dispatch/ module**: dispatch/callback-helpers.ts, dispatch/trace-helpers.ts
- Both helpers use **swallow + log** pattern — catch errors internally and log at warn level (Pino structured logging from Phase 37). Callers fire-and-forget
- deliverAllCallbacksSafely() and captureTraceSafely() as the canonical function names

### OpenClaw adapter cleanup (REF-07)
- withPermissions() HOF in a **separate module**: openclaw/permissions.ts
- Adapter loops over the handler map, wrapping each handler with withPermissions() automatically
- Eliminates 10 copy-pasted execute blocks with `(params as any).actor` / `(params as any).project` extraction

### REF-06 status
- **Marked N/A** — gate-to-DAG migration deduplication was fully resolved by DEAD-04 in Phase 34 (code removed entirely). Plan should note this explicitly for audit trail

### Claude's Discretion
- Exact grouping of action handler files (which action types go in which file)
- Internal structure of the tool-registry map (flat vs nested)
- How MCP-specific content formatting is handled in the thin wrapper
- Naming of grouped handler files within dispatch/

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/tools/aof-tools.ts`: Already delegates to domain-specific modules (project-tools.ts, query-tools.ts, task-tools.ts) — extend this pattern for the handler map
- `src/tools/task-tools.ts`, `src/tools/project-tools.ts`: Existing handler functions that MCP tools.ts wraps — these become the foundation of the shared handler layer
- `src/logging/`: Pino structured logger from Phase 37 — all new helpers use `createLogger(component)` pattern

### Established Patterns
- Module-level `const log = createLogger('component')` for structured logging (Phase 37)
- Sibling module extraction: Phase 36 extracted config/registry.ts alongside existing config/manager.ts
- Zod schema co-location: schemas/ directory has type-specific files (task.ts, workflow-dag.ts, org-chart.ts)

### Integration Points
- `src/dispatch/assign-executor.ts` (544 lines): executeAssignAction() — REF-01, REF-04, REF-05 target
- `src/dispatch/action-executor.ts` (415 lines): executeActions() switch — REF-02 target
- `src/mcp/tools.ts` (781 lines): 15 inline schemas + 15 handlers + registerAofTools() — REF-08 target
- `src/openclaw/adapter.ts` (616 lines): 10 copy-pasted execute blocks — REF-03, REF-07 target
- `src/tools/`: Existing shared tool layer — REF-03 extends this with handler map

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard refactoring approaches within the decisions above.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 38-code-refactoring*
*Context gathered: 2026-03-12*
