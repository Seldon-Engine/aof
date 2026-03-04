# Phase 21: Compressed Skill - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Rewrite `skills/aof/SKILL.md` from 449 lines (~3,250 tokens) to a ~1,500 token reference card. Remove CLI reference, notification events, verbose YAML, and parameter tables. Preserve all agent-facing capability. Tool description trimming and tiered injection are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Content triage
- **Cut entirely:** Human Operator CLI Reference (lines 380-419), Notification Events table (lines 423-436)
- **Cut entirely:** Per-tool parameter tables (tool JSON schemas already document parameters)
- **Cut entirely:** Per-tool JSON examples (agents have schema, don't need copy-paste examples)
- **Keep compressed:** Agent Tools Reference as tool name + when-to-use + return shape (no params, no examples)
- **Keep compressed:** All 4 workflow patterns as 1-2 line summaries each
- **Keep compressed:** Inter-Agent Protocols — envelope format + type table, remove the JSON example line
- **Keep compressed:** DAG Workflows — concept + one linear example (~10 lines), not full pattern library
- **Keep compressed:** Org chart — minimal 5-line YAML snippet (one agent + one team)
- **Merge into tool list:** Decision Table — the per-tool "when to use" one-liners replace it

### Compression style
- **Reference card format** — telegraphic, bullet points, tables, no prose. Maximum density.
- **Token budget: ~1,500 tokens** — this is the hard target, not a line count
- **Frontmatter:** Trim description to one line — the body explains the rest

### DAG workflow depth
- **Concept + one example** — explain hops/dependsOn/conditions in ~10 lines with one linear example
- **Condition DSL:** One-line mention only — "Hops support conditions (has_tag, hop_status, eq, neq + and/or/not)"
- **Legacy gate note:** Cut entirely — v1.3 migrations converted all gate tasks, agents won't encounter them

### Org chart guidance
- **Minimal YAML snippet** — 5-line example (one agent + one team), enough to extend by pattern
- **`aof init` reference:** One-line pointer — "Run `aof init` to auto-sync from OpenClaw config"
- **Routing rules:** Cut — agents use `assignedAgent` param in aof_dispatch, routing is scheduler internals

### Claude's Discretion
- Exact section ordering within the reference card
- Whether to use a single table or multiple sections
- How to handle the AOF/1 protocol type table (inline or separate)
- Projects skill integration (Phase 22 content, but Claude can structure the skill to accommodate it)

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. The key constraint is the ~1,500 token budget with reference card density.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/context/budget.ts`: `estimateTokens()` function (4 chars/token heuristic) — can validate token budget during development
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

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 21-compressed-skill*
*Context gathered: 2026-03-03*
