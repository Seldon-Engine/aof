/**
 * Project linter - validates project structure and task integrity.
 *
 * Validates:
 * - Required directories (tasks, artifacts, state, views, cold)
 * - Artifact medallion tiers (bronze, silver, gold)
 * - Task status matches directory location
 * - Task frontmatter project field matches project id
 * - Project manifest validity
 *
 * Emits lint report to Projects/<id>/state/lint-report.md
 */

import { readdir, writeFile, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectRecord } from "./registry.js";
import type { EventLogger } from "../events/logger.js";
import { TaskStatus } from "../schemas/task.js";
import {
  validateManifest,
  validateDirectories,
  validateArtifactTiers,
  validateHierarchy,
  checkExists,
  formatLintReport,
} from "./lint-helpers.js";

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

/** Valid task status values (lowercase for directory matching). */
const VALID_STATUSES = TaskStatus.options;

/**
 * Lint a project and write report to state/lint-report.md.
 *
 * @param record - Project record from registry
 * @param eventLogger - Optional event logger for validation failures
 * @param allProjects - Optional array of all projects for hierarchy validation
 * @returns Lint result with issues and pass/fail status
 */
export async function lintProject(
  record: ProjectRecord,
  eventLogger?: EventLogger,
  allProjects?: ProjectRecord[]
): Promise<LintResult> {
  const issues: LintIssue[] = [];

  // Check for invalid manifest
  await validateManifest(record, issues, eventLogger);

  // Validate required directories
  await validateDirectories(record, issues);

  // Validate artifact medallion tiers
  await validateArtifactTiers(record, issues);

  // Validate project hierarchy
  await validateHierarchy(record, issues, allProjects);

  // Validate tasks if tasks directory exists
  await validateTasks(record, issues);

  // Write lint report
  await writeLintReport(record, issues);

  return {
    projectId: record.id,
    issues,
    passed: issues.filter((i) => i.severity === "error").length === 0,
  };
}

/**
 * Validate tasks if tasks directory exists.
 */
async function validateTasks(
  record: ProjectRecord,
  issues: LintIssue[]
): Promise<void> {
  const tasksPath = join(record.path, "tasks");
  if (await checkExists(tasksPath)) {
    const taskIssues = await lintTasks(record.id, tasksPath);
    issues.push(...taskIssues);
  }
}

/**
 * Write lint report to project state directory.
 */
async function writeLintReport(
  record: ProjectRecord,
  issues: LintIssue[]
): Promise<void> {
  const report = formatLintReport(record.id, issues);
  const reportPath = join(record.path, "state", "lint-report.md");
  await writeFile(reportPath, report, "utf-8");
}

/**
 * Lint all tasks in the tasks directory.
 *
 * Validates:
 * - Task status matches directory location
 * - Task frontmatter project field matches project id (when present)
 */
async function lintTasks(
  projectId: string,
  tasksPath: string
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  try {
    const statusDirs = await readdir(tasksPath, { withFileTypes: true });

    for (const statusDir of statusDirs) {
      if (!statusDir.isDirectory()) continue;

      const statusName = statusDir.name;

      // Check if status directory is valid
      if (!VALID_STATUSES.includes(statusName as any)) {
        issues.push({
          severity: "warning",
          category: "tasks",
          message: `Unknown task status directory: tasks/${statusName}`,
          path: `tasks/${statusName}`,
        });
        continue;
      }

      // Lint tasks in this status directory
      const statusPath = join(tasksPath, statusName);
      const taskFiles = await readdir(statusPath);

      for (const filename of taskFiles) {
        if (!filename.endsWith(".md")) continue;

        const taskPath = join(statusPath, filename);
        const taskIssues = await lintTaskFile(
          projectId,
          statusName,
          taskPath,
          tasksPath
        );
        issues.push(...taskIssues);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      issues.push({
        severity: "error",
        category: "tasks",
        message: `Failed to scan tasks directory: ${(err as Error).message}`,
      });
    }
  }

  return issues;
}

/**
 * Lint a single task file.
 */
async function lintTaskFile(
  projectId: string,
  expectedStatus: string,
  taskPath: string,
  tasksRoot: string
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const relPath = relative(tasksRoot, taskPath);

  try {
    const content = await readFile(taskPath, "utf-8");
    const frontmatter = extractFrontmatter(content);

    if (!frontmatter) {
      issues.push({
        severity: "warning",
        category: "tasks",
        message: `Task missing frontmatter: ${relPath}`,
        path: relPath,
      });
      return issues;
    }

    // Validate status matches directory
    if (frontmatter.status && frontmatter.status !== expectedStatus) {
      issues.push({
        severity: "error",
        category: "tasks",
        message: `Task status '${frontmatter.status}' does not match directory '${expectedStatus}': ${relPath}`,
        path: relPath,
      });
    }

    // Validate project field matches project id (if present)
    if (frontmatter.project && frontmatter.project !== projectId) {
      issues.push({
        severity: "error",
        category: "tasks",
        message: `Task project '${frontmatter.project}' does not match project id '${projectId}': ${relPath}`,
        path: relPath,
      });
    }
  } catch (err) {
    issues.push({
      severity: "warning",
      category: "tasks",
      message: `Failed to read task file ${relPath}: ${(err as Error).message}`,
      path: relPath,
    });
  }

  return issues;
}

/**
 * Extract and parse YAML frontmatter from a markdown file.
 */
function extractFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match || !match[1]) return null;

  try {
    return parseYaml(match[1]) as Record<string, any>;
  } catch {
    return null;
  }
}
