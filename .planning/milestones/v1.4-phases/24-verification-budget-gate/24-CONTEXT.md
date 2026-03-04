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
- MCP resource descriptions are out of scope for the 50% claim
- **Baseline source:** Git history for actual before values
- **Target tier:** Full tier only for the 50% reduction target

### Budget ceiling value
- **Moderate ceiling:** Current measured value + 25% headroom
- Hardcoded constant in the test file
- Catches large regressions while allowing minor additions without immediate breakage

### Measurement document
- Keep it small — minimal before/after comparison, not a detailed report
- Location: Claude decides best fit (could be .planning/, dev/, or alongside tests)

### Test design
- **Method:** Read actual files from disk — SKILL.md and tool description strings from tools.ts
- Uses `estimateTokens()` from `src/context/budget.ts` for consistent counting
- **Location:** Co-located with other tests (follows existing test patterns)
- **No skill.json accuracy check** — no deterministic way to verify estimated token counts match reality
- Runs in CI alongside existing vitest suite — no special CI config needed

### Claude's Discretion
- How to extract tool descriptions from tools.ts (programmatic import vs regex vs AST)
- Whether to measure tool input schemas as part of tool description token count or just the description strings
- Exact measurement document location and format
- Whether to include seed tier or MCP resource numbers as supplementary data in the measurement doc

</decisions>

<specifics>
## Specific Ideas

- Budget gate should catch regressions automatically — if someone adds a verbose tool description or expands SKILL.md, the test fails

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
