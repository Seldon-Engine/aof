/**
 * Task card linter — validates Instructions and Guidance sections.
 * 
 * Follows the pattern from org/linter.ts.
 * Provides warnings for missing sections (backward compatible).
 * Strict mode errors for runbook-tagged tasks missing Guidance.
 */

import type { Task } from "../schemas/task.js";
import { extractTaskSections } from "../store/task-store.js";

export interface LintIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
  path?: string;
}

export interface LintOptions {
  /** Strict mode: errors instead of warnings for runbook/compliance tasks. */
  strict?: boolean;
}

/**
 * Lint a task card for Instructions and Guidance section presence.
 */
export function lintTaskCard(task: Task, opts: LintOptions = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const sections = extractTaskSections(task.body);
  const { instructionsRef, guidanceRef, requiredRunbook, routing } = task.frontmatter;
  
  const hasRunbookTag = routing.tags?.includes("runbook") ?? false;
  const isRunbookTask = hasRunbookTag || !!requiredRunbook;
  const strict = opts.strict ?? false;

  // Rule: Instructions section should be present (warning)
  if (sections.instructions === undefined) {
    issues.push({
      severity: "warning",
      rule: "instructions-section-present",
      message: "Task body should include an '## Instructions' section for clarity",
      path: "body",
    });
  } else if (sections.instructions.length === 0) {
    issues.push({
      severity: "warning",
      rule: "instructions-section-not-empty",
      message: "Instructions section is present but empty",
      path: "body",
    });
  }

  // Rule: If instructionsRef is set, Instructions section should exist
  if (instructionsRef && sections.instructions === undefined) {
    issues.push({
      severity: "warning",
      rule: "instructions-ref-has-section",
      message: `instructionsRef is set to '${instructionsRef}' but Instructions section is missing`,
      path: "frontmatter.instructionsRef",
    });
  }

  // Rule: If guidanceRef is set, Guidance section should exist
  if (guidanceRef && sections.guidance === undefined) {
    issues.push({
      severity: "warning",
      rule: "guidance-ref-has-section",
      message: `guidanceRef is set to '${guidanceRef}' but Guidance section is missing`,
      path: "frontmatter.guidanceRef",
    });
  }

  // Rule: Guidance section presence (warning if guidanceRef set)
  if (guidanceRef && sections.guidance === undefined) {
    issues.push({
      severity: "warning",
      rule: "guidance-section-present",
      message: "guidanceRef is set but Guidance section is missing from body",
      path: "body",
    });
  } else if (guidanceRef && sections.guidance !== undefined && sections.guidance.length === 0) {
    issues.push({
      severity: "warning",
      rule: "guidance-section-not-empty",
      message: "Guidance section is present but empty",
      path: "body",
    });
  }

  // Strict mode: runbook-tagged tasks MUST have Guidance section
  if (strict && isRunbookTask && sections.guidance === undefined) {
    issues.push({
      severity: "error",
      rule: "guidance-section-required",
      message: "Runbook-tagged tasks must include a '## Guidance' section (strict mode)",
      path: "body",
    });
  }

  return issues;
}
