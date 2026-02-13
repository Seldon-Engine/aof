import type { MemoryConfig } from "./generator.js";

/**
 * Subset of OpenClaw config needed for Memory V2 auditing.
 */
export interface OpenClawConfig {
  agents?: Record<string, AgentConfig>;
}

interface AgentConfig {
  memorySearch?: {
    extraPaths?: string[];
  };
}

/**
 * Per-agent drift details for Memory V2 auditing.
 */
export interface MemoryAuditEntry {
  agentId: string;
  missingPaths: string[];
  extraPaths: string[];
  missingConfig: boolean;
  wildcardIssues: string[];
}

/**
 * Aggregated Memory V2 audit results.
 */
export interface MemoryAuditReport {
  entries: MemoryAuditEntry[];
  summary: {
    hasDrift: boolean;
    driftedAgents: number;
    missingPaths: number;
    extraPaths: number;
    missingConfig: number;
    wildcardIssues: number;
  };
}

/**
 * Compare expected Memory V2 config against the actual OpenClaw config.
 */
export function auditMemoryConfig(expected: MemoryConfig, actual: OpenClawConfig): MemoryAuditReport {
  const expectedAgents = expected.agents ?? {};
  const actualAgents = actual.agents ?? {};
  const agentIds = new Set<string>([...Object.keys(expectedAgents), ...Object.keys(actualAgents)]);

  const entries: MemoryAuditEntry[] = [];
  let missingPaths = 0;
  let extraPaths = 0;
  let missingConfig = 0;
  let wildcardIssues = 0;

  const sortedAgents = Array.from(agentIds).sort();
  for (const agentId of sortedAgents) {
    const expectedPaths = normalizePaths(expectedAgents[agentId]?.memorySearch?.extraPaths);
    const actualPaths = extractActualPaths(actualAgents[agentId]);

    if (expectedPaths.length > 0 && actualPaths === null) {
      entries.push({
        agentId,
        missingPaths: [],
        extraPaths: [],
        missingConfig: true,
        wildcardIssues: [],
      });
      missingConfig += 1;
      continue;
    }

    if (actualPaths === null) {
      continue;
    }

    const expectedSet = new Set(expectedPaths);
    const actualSet = new Set(actualPaths);
    const wildcards = detectWildcardPaths(actualPaths);
    const wildcardSet = new Set(wildcards);
    
    // Exclude wildcards from extra paths to avoid double-counting
    const missing = expectedPaths.filter(path => !actualSet.has(path));
    const extra = actualPaths.filter(path => !expectedSet.has(path) && !wildcardSet.has(path));

    if (missing.length > 0 || extra.length > 0 || wildcards.length > 0) {
      entries.push({
        agentId,
        missingPaths: missing,
        extraPaths: extra,
        missingConfig: false,
        wildcardIssues: wildcards,
      });
      missingPaths += missing.length;
      extraPaths += extra.length;
      wildcardIssues += wildcards.length;
    }
  }

  return {
    entries,
    summary: {
      hasDrift: entries.length > 0,
      driftedAgents: entries.length,
      missingPaths,
      extraPaths,
      missingConfig,
      wildcardIssues,
    },
  };
}

/**
 * Format a Memory V2 audit report for terminal output.
 */
export function formatMemoryAuditReport(report: MemoryAuditReport): string {
  const lines: string[] = [];
  lines.push("Memory V2 Audit Report");
  lines.push("======================");

  if (!report.summary.hasDrift) {
    lines.push("✅ No drift detected — memory config matches org chart");
    return lines.join("\n");
  }

  lines.push("");

  const entries = [...report.entries].sort((a, b) => a.agentId.localeCompare(b.agentId));
  for (const entry of entries) {
    lines.push(`✗ ${entry.agentId}`);

    if (entry.missingConfig) {
      lines.push("  ! missing memorySearch.extraPaths configuration");
    }

    for (const path of entry.missingPaths) {
      lines.push(`  - ${path}`);
    }

    for (const path of entry.extraPaths) {
      lines.push(`  + ${path}`);
    }

    for (const path of entry.wildcardIssues) {
      lines.push(`  ⚠ wildcard detected: ${path}`);
    }

    lines.push("");
  }

  lines.push("Summary:");
  lines.push(`  Agents with drift: ${report.summary.driftedAgents}`);
  lines.push(`  Missing paths: ${report.summary.missingPaths}`);
  lines.push(`  Extra paths: ${report.summary.extraPaths}`);
  lines.push(`  Missing config: ${report.summary.missingConfig}`);
  lines.push(`  Wildcard issues: ${report.summary.wildcardIssues}`);

  return lines.join("\n");
}

function normalizePaths(paths?: string[]): string[] {
  if (!paths) return [];
  const filtered = paths.filter((path): path is string => typeof path === "string");
  return Array.from(new Set(filtered)).sort();
}

function extractActualPaths(config: AgentConfig | undefined): string[] | null {
  if (!config || typeof config !== "object") return null;
  const memorySearch = config.memorySearch;
  if (!memorySearch || typeof memorySearch !== "object") return null;
  if (!Array.isArray(memorySearch.extraPaths)) return null;
  return normalizePaths(memorySearch.extraPaths);
}

/**
 * Detect Projects/** wildcard paths that should not be present.
 * Returns list of problematic paths.
 */
function detectWildcardPaths(paths: string[]): string[] {
  const wildcards: string[] = [];
  for (const path of paths) {
    if (path.includes("Projects/**") || path.includes("Projects/*")) {
      wildcards.push(path);
    }
  }
  return wildcards;
}
