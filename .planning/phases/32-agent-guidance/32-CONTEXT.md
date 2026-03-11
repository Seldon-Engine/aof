# Phase 32: Agent Guidance - Context

**Gathered:** 2026-03-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Update SKILL.md to document subscription and callback behavior so agents understand how to use notifications and respond to callbacks. Covers: tool table additions, new Subscriptions & Callbacks section, idempotency expectations. Does NOT cover: new subscription features (FILT-01, BATCH-01, QUERY-01) or any code changes.

</domain>

<decisions>
## Implementation Decisions

### Documentation structure
- Add a dedicated `## Subscriptions & Callbacks` section after the existing `## Completion Protocol` section
- Add `aof_task_subscribe` and `aof_task_unsubscribe` to the existing Agent Tools table (consistent with single-table pattern)
- Update `aof_dispatch` tool table row to mention `subscribe` param
- Cross-reference: tool table mentions subscribe briefly, new section explains behavior
- Match existing SKILL.md density — terse bullet points, no prose, ~25 lines for the new section

### Callback handler contract
- Contract-focused, not payload-focused: "You receive a session with task results. Process it and exit."
- Idempotency as simple one-line warning: "Delivery is at-least-once. You may receive the same callback more than once. Design handlers to be idempotent."
- Document depth limit briefly: "Callback chains are depth-limited to 3."
- Document 2-minute timeout: "Callback sessions have a 2-minute timeout — keep handlers lightweight."

### Subscribe-at-dispatch
- Brief inline note in new section: `subscribe: true` (completion) or `subscribe: "all"` (every transition)
- Standalone subscribe/unsubscribe tools: tool table entries are sufficient, no extra guidance needed
- Document that subscriber must be a valid agent ID from the org chart

### Granularity explanation
- Two-line comparison: `completion` fires once on terminal states; `all` fires on every status change, batched per poll cycle
- Note that `all` is superset of `completion` — no need for both
- Brief usage guidance: "Use `completion` for react-on-done workflows. Use `all` for progress monitoring."
- Do NOT describe batched transition payload details — agents get this from callback session context

### Claude's Discretion
- Exact wording and line ordering within the new section
- Whether to use a small table or bullet list for granularity comparison
- How to compress the tool table descriptions for subscribe/unsubscribe

</decisions>

<specifics>
## Specific Ideas

No specific requirements — follow existing SKILL.md patterns and density.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `skills/aof/SKILL.md`: Current standing context — 206 lines, structured with tool table, DAG section, protocols, org chart, projects, completion protocol
- `src/dispatch/__tests__/skill-budget.test.ts`: Budget gate CI test that caps SKILL.md token count

### Established Patterns
- Agent Tools table: `| tool | purpose | returns |` format, no parameter tables ("tool JSON schemas provide full parameter docs at call time")
- Sections are dense, bulleted, with minimal prose
- Cross-references between sections (e.g., DAG section references tool table)

### Integration Points
- Tool table in SKILL.md: add 2 new rows (subscribe, unsubscribe), update aof_dispatch row
- After `## Completion Protocol`: insert new `## Subscriptions & Callbacks` section
- Budget gate test: must still pass after changes

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 32-agent-guidance*
*Context gathered: 2026-03-11*
