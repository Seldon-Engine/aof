# Phase 23: Tiered Context Delivery - Context

**Gathered:** 2026-03-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Context injection supports two tiers — seed (minimal) and full (complete skill) — so agents working on simple tasks receive significantly less context while complex tasks get the full compressed skill. The tier selection is explicit and deterministic (caller specifies at dispatch time), not LLM-decided.

</domain>

<decisions>
## Implementation Decisions

### Tier boundary
- `aof_dispatch` gets a `contextTier: 'seed' | 'full'` parameter
- Default to `seed` — most tasks are simple, agents opt-in to full when they need workflows/org chart
- Tier stored on task frontmatter (`contextTier: seed|full`) for crash recovery and auditability
- Agents can upgrade mid-session via `aof_context_load` tool call (lazy loading — seed agents only pay for full if they actually need it)

### Seed content
- Separate file: `SKILL-SEED.md` maintained alongside `SKILL.md`
- Content: tool table (8 tools) + AOF/1 envelope + completion outcomes + mini workflow hint ("For DAG workflows, request contextTier: full or call aof_context_load")
- Include inter-agent protocol details (AOF/1 envelope, protocol types, completion outcomes) — even simple tasks need protocol format
- Do NOT include: projects section, DAG workflow depth, org chart guidance — those are full tier
- Target: ~55 lines, ~500 tokens (vs 193 lines / 1665 tokens for full — ~70% reduction)

### Selection mechanism
- `skill.json` gets a `tiers` field: `{ seed: { entrypoint: 'SKILL-SEED.md', estimatedTokens: ~500 }, full: { entrypoint: 'SKILL.md', estimatedTokens: 1665 } }`
- `SkillResolver.resolve()` accepts an optional tier parameter, checks skill.json tiers, reads the appropriate file
- If requested tier doesn't exist in skill.json, fall back to the main entrypoint (full) gracefully — no errors, worst case is over-injection
- Installer (init-steps.ts) copies both SKILL.md and SKILL-SEED.md to ~/.openclaw/skills/aof/

### Integration path
- `contextTier` added to `dispatchInputSchema` in tools.ts (mirrors Phase 21 workflow param pattern)
- Flows through to task frontmatter via store.create()
- SkillResolver reads tier — single code path for both initial injection and on-demand loading
- Both tiers get token estimates in skill.json for accurate budget evaluation (feeds Phase 24's budget gate)

### Claude's Discretion
- Exact SkillResolver API changes (parameter signature, backward compatibility)
- Task frontmatter schema extension (where contextTier lives in the Zod schema)
- How OpenClaw adapter reads contextTier from task to pass to skill resolver
- SKILL-SEED.md exact content and formatting
- Test strategy (unit tests for resolver tier selection, integration tests for dispatch flow)

</decisions>

<specifics>
## Specific Ideas

- SKILL-SEED.md should include a clear "upgrade path" note so agents know they can request full context
- The mini workflow hint in seed should mention both `contextTier: 'full'` on dispatch and `aof_context_load` for mid-session upgrade
- Token estimates in skill.json should be accurate (computed same way as Phase 22 — ceil(chars/4))

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/context/skills.ts`: `SkillManifest` interface and `loadSkillManifest()` — extend with tiers field
- `src/context/resolvers.ts`: `SkillResolver` — add tier parameter to resolve()
- `src/context/budget.ts`: `estimateTokens()` — use for token estimates in skill.json
- `src/tools/context-tools.ts`: `aofContextLoad` — already supports on-demand skill loading (upgrade path)
- `src/context/assembler.ts`: `ContextManifest` with seed/optional/deep layers — existing tier concept

### Established Patterns
- Phase 21 added `workflow` param to dispatch — same pattern for `contextTier`
- `dispatchInputSchema` uses Zod unions — `contextTier` can be `z.enum(['seed', 'full']).optional().default('seed')`
- skill.json manifest v1 — extend with optional `tiers` field (backward compatible)
- `init-steps.ts` copies skill files to `~/.openclaw/skills/aof/` — add SKILL-SEED.md

### Integration Points
- `src/mcp/tools.ts`: Add `contextTier` to `dispatchInputSchema`, pass through to store.create()
- `skills/aof/skill.json`: Add `tiers` field with seed/full entrypoints and token estimates
- `skills/aof/SKILL-SEED.md`: New file — minimal skill for simple tasks
- `src/context/skills.ts`: Extend `SkillManifest` with optional `tiers` field
- `src/context/resolvers.ts`: `SkillResolver.resolve()` accepts tier parameter
- `src/cli/init-steps.ts`: Copy SKILL-SEED.md alongside SKILL.md during install

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 23-tiered-context-delivery*
*Context gathered: 2026-03-04*
