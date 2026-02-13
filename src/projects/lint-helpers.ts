/**
 * Lint helpers - validation and formatting utilities.
 */

import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ProjectRecord } from "./registry.js";
import type { LintIssue } from "./lint.js";
import type { EventLogger } from "../events/logger.js";

/** Required top-level directories. */
const REQUIRED_DIRS = ["tasks", "artifacts", "state", "views", "cold"];

/** Required artifact tier subdirectories. */
const ARTIFACT_TIERS = ["bronze", "silver", "gold"];

/**
 * Validate project manifest and emit event if invalid.
 */
export async function validateManifest(
  record: ProjectRecord,
  issues: LintIssue[],
  eventLogger?: EventLogger
): Promise<void> {
  if (record.error) {
    issues.push({
      severity: "error",
      category: "manifest",
      message: `Invalid project.yaml: ${record.error}`,
    });

    // Emit validation failed event
    if (eventLogger) {
      await eventLogger.log("project.validation.failed", "system", {
        payload: {
          projectId: record.id,
          error: record.error,
        },
      });
    }
  }
}

/**
 * Validate required project directories.
 */
export async function validateDirectories(
  record: ProjectRecord,
  issues: LintIssue[]
): Promise<void> {
  for (const dir of REQUIRED_DIRS) {
    const dirPath = join(record.path, dir);
    const exists = await checkExists(dirPath);
    if (!exists) {
      issues.push({
        severity: "error",
        category: "structure",
        message: `Missing required directory: ${dir}`,
        path: relative(record.path, dirPath),
      });
    }
  }
}

/**
 * Validate artifact medallion tier subdirectories.
 */
export async function validateArtifactTiers(
  record: ProjectRecord,
  issues: LintIssue[]
): Promise<void> {
  const artifactsPath = join(record.path, "artifacts");
  if (await checkExists(artifactsPath)) {
    for (const tier of ARTIFACT_TIERS) {
      const tierPath = join(artifactsPath, tier);
      const exists = await checkExists(tierPath);
      if (!exists) {
        issues.push({
          severity: "error",
          category: "artifacts",
          message: `Missing artifact tier: artifacts/${tier}`,
          path: relative(record.path, tierPath),
        });
      }
    }
  }
}

/**
 * Check if a path exists.
 */
export async function checkExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format lint issues into a markdown report.
 */
export function formatLintReport(projectId: string, issues: LintIssue[]): string {
  const timestamp = new Date().toISOString();
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  let report = `# Project Lint Report: ${projectId}\n\n`;
  report += `**Generated:** ${timestamp}\n\n`;
  report += `**Status:** ${errorCount === 0 ? "✓ PASSED" : "✗ FAILED"}\n\n`;
  report += `**Summary:** ${errorCount} error(s), ${warningCount} warning(s)\n\n`;

  if (issues.length === 0) {
    report += "No issues found.\n";
    return report;
  }

  // Group issues by category
  const byCategory = new Map<string, LintIssue[]>();
  for (const issue of issues) {
    const existing = byCategory.get(issue.category) || [];
    existing.push(issue);
    byCategory.set(issue.category, existing);
  }

  // Emit issues by category
  for (const [category, categoryIssues] of byCategory.entries()) {
    report += `## ${capitalize(category)}\n\n`;

    for (const issue of categoryIssues) {
      const icon = issue.severity === "error" ? "❌" : "⚠️";
      report += `- ${icon} **${issue.severity.toUpperCase()}**: ${issue.message}\n`;
      if (issue.path) {
        report += `  - Path: \`${issue.path}\`\n`;
      }
    }

    report += "\n";
  }

  return report;
}

/**
 * Capitalize first letter of a string.
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Validate project hierarchy relationships.
 *
 * Checks:
 * - Warning if parentId references non-existent project
 * - Error on circular parent references
 */
export async function validateHierarchy(
  record: ProjectRecord,
  issues: LintIssue[],
  allProjects?: ProjectRecord[]
): Promise<void> {
  if (!record.manifest?.parentId || !allProjects) {
    return;
  }

  const parentId = record.manifest.parentId;

  // Check if parent exists
  const parentExists = allProjects.some((p) => p.id === parentId);
  if (!parentExists) {
    issues.push({
      severity: "warning",
      category: "hierarchy",
      message: `Parent project '${parentId}' does not exist`,
      path: "project.yaml",
    });
    return;
  }

  // Check for circular references
  const cycle = detectCircularParent(record.id, allProjects);
  if (cycle) {
    issues.push({
      severity: "error",
      category: "hierarchy",
      message: `Circular parent reference detected: ${cycle.join(" → ")}`,
      path: "project.yaml",
    });
  }
}

/**
 * Detect circular parent references starting from a project ID.
 *
 * Returns the cycle path if found, or null if no cycle.
 */
function detectCircularParent(
  startId: string,
  allProjects: ProjectRecord[]
): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [];
  let currentId: string | undefined = startId;

  while (currentId) {
    if (visited.has(currentId)) {
      // Found a cycle - return the cycle path
      const cycleStart = path.indexOf(currentId);
      return [...path.slice(cycleStart), currentId];
    }

    visited.add(currentId);
    path.push(currentId);

    // Find parent
    const project = allProjects.find((p) => p.id === currentId);
    currentId = project?.manifest?.parentId;
  }

  return null;
}
