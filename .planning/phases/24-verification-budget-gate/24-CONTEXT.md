# Phase 24: Verification & Budget Gate - Context

**Gathered:** 2026-03-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Prove the v1.4 context optimization achieved 50%+ reduction with before/after measurements, and protect the budget with an automated test that fails if context exceeds the ceiling. This phase produces a measurement document (MEAS-01) and a vitest budget gate (MEAS-02).

</domain>

<decisions>
## Implementation Decisions

### What counts as "total context"
- **Scope:** SKILL.md + tool descriptions (registerTool description strings in tools.ts)
- MCP resource descriptions (~1KB) are NOT part of the 50% claim but are shown as a separate line item for completeness
- **Baseline source:** Check out pre-v1.4 files from git history to measure actual before values — no manual/estimated numbers
- **Target tier:** 50% reduction target applies to the full tier only (seed tier documented as supplementary data)

### Budget ceiling value
- Ceiling = 50% of pre-v1.4 baseline (computed from git history measurement)
- Separate budget ceiling for seed tier (prevents seed from growing unchecked)
- **Constants:** Hardcoded in the test file as named constants (e.g. `FULL_TIER_BUDGET = <computed>`)
- **Failure output:** On budget exceeded, print breakdown: total tokens, skill tokens, tool description tokens, ceiling value, overage amount

### Measurement document
- Lives in `.planning/phases/24-verification-budget-gate/24-MEASUREMENT.md`
- Format: before/after table with component breakdown (skill, tool descriptions), tokens before, tokens after, reduction %
- Summary line proving 50%+ total reduction
- Includes seed tier numbers as a supplementary section
- Includes MCP resources as a separate row for full transparency (not counted toward 50% target)

### Test design
- **Method:** Read actual files from disk — SKILL.md, SKILL-SEED.md, and tool description strings from tools.ts source
- Uses `estimateTokens()` from `src/context/budget.ts` for consistent counting
- **Location:** `src/context/__tests__/context-budget-gate.test.ts` alongside existing budget.test.ts
- **Skill.json accuracy check:** Test also verifies that skill.json `estimatedTokens` values match actual file content (catches manifest drift)
- Runs in CI alongside existing vitest suite — no special CI config needed

### Claude's Discretion
- How to extract tool descriptions from tools.ts (programmatic import vs regex parsing vs AST) — pick whichever is most reliable
- Exact tolerance for skill.json accuracy check (exact match or within a small delta)
- Whether to measure tool input schemas as part of tool description token count or just the description strings
- Measurement document prose and methodology section depth

</decisions>

<specifics>
## Specific Ideas

- Budget gate should catch regressions automatically — if someone adds a verbose tool description or expands SKILL.md, the test fails
- The git baseline measurement gives the most credible "before" numbers — no room for cherry-picked estimates

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/context/budget.ts`: `estimateTokens()` (4 chars/token heuristic) — use for all token counting
- `src/context/__tests__/budget.test.ts`: Existing budget test patterns — follow same structure
- `skills/aof/skill.json`: Has `tiers` field with `estimatedTokens` for seed (563) and full (1665)
- `skills/aof/SKILL.md`: 6663 bytes / ~1665 tokens (current full skill)
- `skills/aof/SKILL-SEED.md`: 2252 bytes / ~563 tokens (current seed skill)

### Established Patterns
- Vitest test structure: `describe`/`it`/`expect` with co-located test files
- Test discovery: `src/**/*.test.ts` pattern in vitest.config.ts
- Token estimation: `Math.ceil(text.length / 4)` — consistent across codebase
- CI: tests run via `npm test` in GitHub Actions workflow

### Integration Points
- `src/mcp/tools.ts`: Tool descriptions registered via `server.registerTool()` — source of tool description tokens
- `skills/aof/skill.json`: Token estimates must stay in sync with actual files
- `.github/workflows/`: Existing CI runs `npm test` — budget gate test automatically included

### Pre-v1.4 Baseline References
- Phase 22 verification: SKILL.md was 464 lines / 3411 tokens before compression
- STATE.md research: total injection was ~20KB per session
- Tool descriptions were trimmed in Phase 21 — git history has before/after

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 24-verification-budget-gate*
*Context gathered: 2026-03-04*
