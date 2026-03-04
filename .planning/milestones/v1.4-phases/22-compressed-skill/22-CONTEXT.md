# Phase 22: Compressed Skill - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Rewrite `skills/aof/SKILL.md` from 449 lines (~3,250 tokens) into a compressed skill. Remove CLI reference, notification events, verbose YAML, and parameter tables. Preserve all agent-facing capability. The DAG workflow section and org chart guidance are the highest-priority content. Tool description trimming and tiered injection are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Content triage (Claude's discretion)
- **Cut entirely:** Human Operator CLI Reference, Notification Events table, Decision Table
- **Cut entirely:** Per-tool parameter tables (tool JSON schemas already document parameters)
- **Cut entirely:** Per-tool JSON examples (agents have schema, don't need copy-paste examples)
- **Keep compressed:** Agent Tools Reference as tool name + when-to-use + return shape
- **Keep compressed:** All 4 workflow patterns as short summaries
- **Keep compressed:** Inter-Agent Protocols
- **Keep with proper depth:** DAG Workflows (see below — highest priority section)
- **Keep with proper depth:** Org chart guidance (see below — critical section)

### Compression style
- **Hybrid format** — tables for structured data (tools, protocols), bullets for patterns/workflows, minimal prose for context
- No specific token or line budget — let DAG and org chart depth drive the size, then compress everything else around it

### DAG workflow depth (MOST IMPORTANT)
- This is the most important section in the skill — do it right with examples and proper guidance
- Agents compose DAG workflows through `aof_dispatch` (not CLI, not YAML frontmatter)
- **Phase 22 will add a `workflow` parameter to `aof_dispatch`** — write the skill assuming this exists
- Include examples of: linear pipelines, review cycles with rejection, parallel fan-out with join
- Document condition DSL properly (not just a one-liner)
- Document hop concepts: executor, dependsOn, canReject, rejectionStrategy, joinType
- Cut legacy gate migration note — v1.3 already cleaned that up

### Org chart guidance (critical)
- Use Claude's best judgement on depth, but this section is critical for agent-led provisioning
- Must be sufficient for an agent to set up teams, agents, and routing
- Include `aof init` reference for auto-sync with OpenClaw

### Claude's Discretion
- Exact section ordering and formatting
- How much to compress non-priority sections (tools ref, protocols, workflow patterns) to make room for DAG and org chart depth
- Whether routing rules belong in the skill or are purely scheduler internals
- Projects skill structure (Phase 22 merges it in, but skill can be structured to accommodate)

</decisions>

<specifics>
## Specific Ideas

- DAG section should feel like proper guidance, not a compressed afterthought
- Org chart section needs to enable agent-led provisioning, not just reference it
- Everything else can be aggressively compressed to make room

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/context/budget.ts`: `estimateTokens()` function (4 chars/token heuristic) — can validate token count
- `src/context/skills.ts`: `SkillManifest` with `estimatedTokens` field — update after compression
- `skills/aof/SKILL.md`: Current 449-line file to be replaced
- `src/skills/projects/SKILL.md`: 50-line projects skill (merged in Phase 22, not this phase)

### Established Patterns
- Skill frontmatter: YAML header with name, description, version, requires fields
- Skills loaded via `loadSkillManifest()` from `skill.json` in skill directory
- OpenClaw injects SKILL.md content into agent sessions automatically

### Integration Points
- `skills/aof/SKILL.md` — direct replacement, same path
- `skill.json` manifest in `skills/aof/` — update `estimatedTokens` after compression
- Tool descriptions in `src/mcp/tools.ts` — Phase 22 trims these, but Phase 21 skill must not duplicate them
- `src/mcp/resources.ts` — MCP resources remain unchanged

### Critical Gap Found During Discussion
- `aof_dispatch` in `src/mcp/tools.ts` has NO `workflow` parameter — agents cannot compose DAG workflows through MCP tools
- v1.2 requirement TMPL-02 was implemented as YAML frontmatter only, not as a tool API
- Phase 22 must add `workflow` param to `aof_dispatch` schema + wire it through `handleAofDispatch`
- Phase 21 skill should be written assuming this param exists (to avoid rewriting later)

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 22-compressed-skill*
*Context gathered: 2026-03-03*
