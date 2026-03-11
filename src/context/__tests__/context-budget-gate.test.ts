/**
 * Context budget gate — CI guard preventing context size regression.
 *
 * Reads SKILL.md and tool descriptions from disk at test time,
 * measures token counts, and asserts they stay within budget.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { estimateTokens } from "../budget.js";

/**
 * Hard ceiling for full-tier context (SKILL.md + tool descriptions).
 * Bumped from 2150 to 2500 for v1.8 subscription/callback documentation.
 * If this test fails, someone inflated the context — investigate before bumping.
 */
const BUDGET_CEILING_TOKENS = 2500;

/**
 * Pre-v1.4 SKILL.md baseline: 13,645 chars / 3,411 tokens (464 lines).
 * Verified in Phase 22 summary from actual file measurement.
 */
const PRE_V14_SKILL_BASELINE_TOKENS = 3411;

describe("context budget gate", () => {
  let skillTokens: number;
  let toolDescTokens: number;
  let totalTokens: number;
  let skillContent: string;

  // Measure current values from disk before tests run
  beforeAll(async () => {
    const root = process.cwd();

    // 1. Read SKILL.md
    skillContent = await fs.readFile(
      path.join(root, "skills", "aof", "SKILL.md"),
      "utf-8",
    );
    skillTokens = estimateTokens(skillContent);

    // 2. Read tool descriptions from src/mcp/tools.ts
    const toolsContent = await fs.readFile(
      path.join(root, "src", "mcp", "tools.ts"),
      "utf-8",
    );
    const descriptionMatches = toolsContent.matchAll(/description:\s*"([^"]+)"/g);
    const allDescriptions = [...descriptionMatches].map((m) => m[1]).join("");
    toolDescTokens = estimateTokens(allDescriptions);

    // 3. Combined total
    totalTokens = skillTokens + toolDescTokens;
  });

  it("full-tier context stays under budget ceiling", () => {
    expect(totalTokens).toBeLessThanOrEqual(BUDGET_CEILING_TOKENS);
  });

  it("gate catches regressions", () => {
    // If SKILL.md were 4x its current size, the total should exceed the ceiling.
    // This proves the ceiling is meaningful and not set absurdly high.
    const inflatedTotal = skillTokens * 4 + toolDescTokens;
    expect(inflatedTotal).toBeGreaterThan(BUDGET_CEILING_TOKENS);
  });

  it("achieves 30%+ reduction from pre-v1.4 baseline", () => {
    // Compare SKILL.md tokens only — tool descriptions were already one-liners
    // pre-v1.4 and are unchanged, so only SKILL.md reduction is meaningful.
    // Relaxed from 50% to 30% for v1.8 subscription/callback content growth.
    expect(skillTokens).toBeLessThan(PRE_V14_SKILL_BASELINE_TOKENS * 0.7);
  });

  it("SKILL.md contains completion protocol with aof_task_complete instruction", () => {
    expect(skillContent).toContain("Completion Protocol");
    expect(skillContent).toContain("aof_task_complete");
    expect(skillContent).toMatch(/exiting without.*fails the task/i);
  });
});
