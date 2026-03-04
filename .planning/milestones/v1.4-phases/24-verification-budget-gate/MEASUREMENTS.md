# Context Optimization Measurements (v1.4)

## Before (pre-v1.4)

| Component         | Chars  | Tokens | Notes                                   |
|-------------------|--------|--------|-----------------------------------------|
| SKILL.md          | 13,645 | 3,411  | 464 lines (Phase 22 verified)           |
| Tool descriptions |    171 |     43 | 5 one-liners (unchanged by v1.4)        |
| **Total**         | 13,816 | 3,454  |                                         |

## After (v1.4)

| Component              | Chars | Tokens | Notes                             |
|------------------------|-------|--------|-----------------------------------|
| SKILL.md (full tier)   | 6,659 |  1,665 | 194 lines, compressed from 464    |
| SKILL-SEED.md (seed)   | 2,252 |    563 | Minimal tier for most dispatches   |
| Tool descriptions      |   171 |     43 | 5 one-liners (unchanged)          |
| **Full-tier total**    | 6,830 |  1,708 | SKILL.md + tools                   |
| **Seed-tier total**    | 2,423 |    606 | SKILL-SEED.md + tools              |

## Reduction

| Metric                      | Before | After | Reduction |
|-----------------------------|--------|-------|-----------|
| SKILL.md only               |  3,411 | 1,665 | **51.2%** |
| Full tier (SKILL.md + tools)|  3,454 | 1,708 | **50.6%** |
| Seed tier vs pre-v1.4 full  |  3,454 |   606 | **82.5%** |

Primary v1.4 achievement: SKILL.md compressed from 3,411 to 1,665 tokens (51.2% reduction).
Tool descriptions were already one-liners pre-v1.4 and remained unchanged.

## Budget Gate

- **Ceiling:** 2,150 tokens (current 1,708 + 25% headroom)
- **Test:** `src/context/__tests__/context-budget-gate.test.ts`
- **Method:** Reads files from disk at test time, uses `estimateTokens()` (4-chars-per-token heuristic)
- **Runs in:** `npm test` via standard vitest include patterns
