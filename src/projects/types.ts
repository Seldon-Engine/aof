/**
 * Shared types for projects module.
 *
 * Extracted to break the circular dependency between lint.ts and lint-helpers.ts.
 */

/** Lint issue severity. */
export type LintSeverity = "error" | "warning";

/** Single lint issue. */
export interface LintIssue {
  severity: LintSeverity;
  category: string;
  message: string;
  path?: string;
}

/** Lint result for a project. */
export interface LintResult {
  projectId: string;
  issues: LintIssue[];
  /** True if project passed all checks. */
  passed: boolean;
}
