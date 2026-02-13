/**
 * Drift Report Formatter — Actionable CLI output
 */

import type { DriftReport } from "./detector.js";

/**
 * Format drift report as actionable CLI output
 */
export function formatDriftReport(report: DriftReport): string {
  const lines: string[] = [];

  if (!report.summary.hasDrift) {
    lines.push("✅ No drift detected — org chart matches OpenClaw reality");
    return lines.join("\n");
  }

  lines.push(`⚠️  Drift detected: ${report.summary.totalIssues} issues found\n`);

  // Missing agents
  if (report.missing.length > 0) {
    lines.push(`Missing (${report.missing.length}):`);
    lines.push("  Agents defined in org chart but not found in OpenClaw:\n");
    for (const item of report.missing) {
      lines.push(`  ✗ ${item.agentId} (${item.name})`);
      lines.push(`    OpenClaw ID: ${item.openclawAgentId}`);
      lines.push(`    Action: Create agent or remove from org chart\n`);
    }
  }

  // Extra agents
  if (report.extra.length > 0) {
    lines.push(`Extra (${report.extra.length}):`);
    lines.push("  Agents in OpenClaw but not in org chart:\n");
    for (const item of report.extra) {
      lines.push(`  ✗ ${item.openclawAgentId} (${item.name})`);
      lines.push(`    Action: Add to org chart or deactivate agent\n`);
    }
  }

  // Mismatches
  if (report.mismatch.length > 0) {
    lines.push(`Mismatch (${report.mismatch.length}):`);
    lines.push("  Agents with property differences:\n");
    for (const item of report.mismatch) {
      lines.push(`  ✗ ${item.agentId} (${item.openclawAgentId})`);
      lines.push(`    Field: ${item.field}`);
      lines.push(`    Org chart: "${item.orgValue}"`);
      lines.push(`    OpenClaw:  "${item.openclawValue}"`);
      lines.push(`    Action: Update org chart or agent config\n`);
    }
  }

  // Permission profiles needed
  if (report.needsPermissionProfile.length > 0) {
    lines.push(`Permission Profile (${report.needsPermissionProfile.length}):`);
    lines.push("  Agents with policies but no permission profile:\n");
    for (const item of report.needsPermissionProfile) {
      lines.push(`  ⚠  ${item.agentId} (${item.openclawAgentId})`);
      lines.push(`    Reason: ${item.reason}`);
      lines.push(`    Action: Create permission profile in OpenClaw config\n`);
    }
  }

  // Summary
  lines.push("Summary:");
  lines.push(`  Total issues: ${report.summary.totalIssues}`);
  lines.push(`  Missing: ${report.summary.categories.missing}`);
  lines.push(`  Extra: ${report.summary.categories.extra}`);
  lines.push(`  Mismatch: ${report.summary.categories.mismatch}`);
  lines.push(`  Needs permission profile: ${report.summary.categories.needsPermissionProfile}`);

  return lines.join("\n");
}
