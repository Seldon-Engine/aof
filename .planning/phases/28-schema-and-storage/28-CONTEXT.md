# Phase 28: Schema and Storage - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Subscription data model with Zod schema validation and crash-safe filesystem persistence. CRUD operations for creating, reading, updating, and deleting subscriptions. No delivery logic, no MCP tools — just the schema and store foundation.

</domain>

<decisions>
## Implementation Decisions

### Storage location
- Co-located `subscriptions.json` file alongside the task `.md` file in the task directory
- NOT in task frontmatter — keeps subscription state separate from task metadata
- Uses `write-file-atomic` for crash-safe writes (same as all other AOF file operations)

### Directory model
- Tasks with subscriptions use the directory model: `tasks/<status>/<id>/subscriptions.json`
- Always create the task directory when a subscription is added (promote bare .md to directory)
- subscriptions.json moves with the task directory during status transitions (rename() handles it)
- Follows existing pattern: task directories already hold inputs/, outputs/, work/ subdirs

### Lifecycle
- subscriptions.json travels with the task — archive/delete removes subscriptions too
- Delivered/failed subscriptions stay in the file as audit trail
- No separate cleanup needed — task lifecycle governs subscription lifecycle

### Claude's Discretion
- Subscription identity scheme (UUID, agent+task combo, or other)
- SubscriptionStore API shape (standalone class vs functions like task-file-ops.ts)
- Zod schema field details beyond what research specified (subscriberId, granularity, status, timestamps)

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches following existing codebase patterns.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `write-file-atomic`: Already used everywhere for crash-safe writes
- `TaskFrontmatter` Zod schema in `src/schemas/task.ts`: Pattern for schema definition with preprocess, superRefine, describe
- `trace-writer.ts`: Pattern for co-located JSON file writes with atomic persistence

### Established Patterns
- Zod schemas are source of truth, TypeScript types derived via `z.infer<>`
- Task directories: `tasks/<status>/<id>/` with subdirs (inputs/, outputs/, work/)
- Functional-style file ops in `task-file-ops.ts` (pure functions, callbacks for store binding)
- DAG state persistence: mutate object → serialize → writeFileAtomic

### Integration Points
- `task-store.ts`: taskDir() method resolves task directory path
- `task-lifecycle.ts`: Status transitions move entire task directory via rename()
- `ensureTaskDirs()`: Creates standard subdirs — may need extension or separate call for subscriptions

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 28-schema-and-storage*
*Context gathered: 2026-03-09*
