/**
 * Shared types for org module.
 *
 * Extracted to break the circular dependency between linter.ts and linter-helpers.ts.
 */

export interface LintIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
  path?: string;
}
