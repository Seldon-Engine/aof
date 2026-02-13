/**
 * Runbook schema — structured operational runbooks for task types.
 *
 * Runbooks provide step-by-step guidance for common task patterns.
 * They can be attached to tasks via `required_runbook` field.
 */

import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FRONTMATTER_FENCE = "---";

/**
 * Runbook frontmatter schema.
 */
export const RunbookFrontmatter = z.object({
  /** Unique runbook identifier (e.g., "deploy-backend"). */
  id: z.string().min(1),

  /** Human-readable title. */
  title: z.string().min(1),

  /** Owning team (e.g., "swe", "ops"). */
  team: z.string().min(1),

  /** Task type this runbook applies to (e.g., "deploy", "incident"). */
  taskType: z.string().min(1),

  /** Semantic version (e.g., "1.2.3"). */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),

  /** ISO timestamp of creation. */
  createdAt: z.string().datetime(),

  /** ISO timestamp of last update. */
  updatedAt: z.string().datetime(),

  /** Optional runbook owner/maintainer. */
  owner: z.string().optional(),

  /** Optional tags for categorization. */
  tags: z.array(z.string()).optional(),

  /** Optional estimated duration in minutes. */
  estimatedDurationMinutes: z.number().int().positive().optional(),
});

export type RunbookFrontmatter = z.infer<typeof RunbookFrontmatter>;

/**
 * Parsed runbook structure.
 */
export interface Runbook {
  frontmatter: RunbookFrontmatter;
  body: string;
  path?: string;
}

/**
 * Parse a runbook markdown file with YAML frontmatter.
 */
export function parseRunbookFile(raw: string, filePath?: string): Runbook {
  const lines = raw.split("\n");

  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    throw new Error("Runbook file must start with YAML frontmatter (---)");
  }

  const endIdx = lines.indexOf(FRONTMATTER_FENCE, 1);
  if (endIdx === -1) {
    throw new Error("Unterminated YAML frontmatter (missing closing ---)");
  }

  const yamlBlock = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n").trim();
  const rawFrontmatter = parseYaml(yamlBlock) as unknown;
  const frontmatter = RunbookFrontmatter.parse(rawFrontmatter);

  return { frontmatter, body, path: filePath };
}

/**
 * Serialize a runbook back to markdown with YAML frontmatter.
 */
export function serializeRunbook(runbook: Runbook): string {
  const yaml = stringifyYaml(runbook.frontmatter, { lineWidth: 120 });
  return `${FRONTMATTER_FENCE}\n${yaml}${FRONTMATTER_FENCE}\n\n${runbook.body}\n`;
}

/**
 * Recommended runbook structure sections.
 */
export const RUNBOOK_TEMPLATE = `---
id: RUNBOOK_ID
title: RUNBOOK_TITLE
team: TEAM_NAME
taskType: TASK_TYPE
version: 1.0.0
createdAt: CREATED_AT
updatedAt: UPDATED_AT
---

## Purpose
Brief description of what this runbook achieves.

## Prerequisites
- List prerequisites (e.g., credentials, access, tools)
- Check these before starting

## Steps
1. First step with details
2. Second step with commands or actions
3. Third step...

## Verification
- How to verify success (health checks, smoke tests)
- What indicators show completion

## Rollback
- How to revert changes if something goes wrong
- Rollback steps in reverse order

## Notes
- Common issues and troubleshooting tips
- Links to related documentation
`;
