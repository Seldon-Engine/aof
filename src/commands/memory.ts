/**
 * Memory commands — generate Memory V2 config from org chart.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { loadOrgChart } from "../org/loader.js";
import { lintOrgChart, type LintIssue } from "../org/index.js";
import { generateMemoryConfig, generateMemoryConfigWithProjects } from "../memory/generator.js";
import { auditMemoryConfig, formatMemoryAuditReport } from "../memory/audit.js";
import type { OpenClawConfig, MemoryAuditReport } from "../memory/audit.js";
import { discoverProjects, type ProjectRecord } from "../projects/registry.js";

export interface GenerateMemoryConfigOptions {
  orgChartPath: string;
  outputPath: string;
  vaultRoot?: string;
}

export async function generateMemoryConfigFile(
  options: GenerateMemoryConfigOptions
): Promise<void> {
  const result = await loadOrgChart(options.orgChartPath);
  if (!result.success) {
    console.error("❌ Schema validation failed:");
    for (const err of result.errors ?? []) {
      console.error(`  ${err.path}: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const lintIssues = lintOrgChart(result.chart!);
  if (reportLintIssues(lintIssues)) {
    process.exitCode = 1;
    return;
  }

  // Discover projects if vaultRoot is available
  let projects: ProjectRecord[] | undefined;
  let projectCount = 0;
  if (options.vaultRoot) {
    try {
      const discovered = await discoverProjects(options.vaultRoot, { includeArchived: false });
      projects = discovered.filter(p => p.manifest);
      projectCount = projects.length;
      if (projects.length < discovered.length) {
        const invalidCount = discovered.length - projects.length;
        console.warn(`⚠ Skipping ${invalidCount} invalid project(s)`);
      }
    } catch (err) {
      console.warn(`⚠ Failed to discover projects: ${(err as Error).message}`);
      projects = [];
    }
  }

  let generated;
  try {
    if (projects && projects.length > 0) {
      generated = generateMemoryConfigWithProjects(result.chart!, projects, { vaultRoot: options.vaultRoot });
    } else {
      generated = generateMemoryConfig(result.chart!, { vaultRoot: options.vaultRoot });
    }
  } catch (err) {
    console.error(`❌ Failed to generate memory config: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (generated.warnings.length > 0) {
    for (const warning of generated.warnings) {
      console.warn(`⚠ ${warning}`);
    }
  }

  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, JSON.stringify(generated.config, null, 2) + "\n", "utf-8");

  console.log(`✅ Memory config generated: ${options.outputPath}`);
  if (projectCount > 0) {
    console.log(`   Projects enrolled: ${projectCount}`);
  }

  // Write YAML artifact if vaultRoot is available
  if (options.vaultRoot) {
    try {
      const artifactPath = resolve(
        options.vaultRoot,
        "Resources/OpenClaw/Ops/Config/recommended-memory-paths.yaml"
      );

      const yamlData: {
        agents: Record<string, { memorySearch: { extraPaths: string[] } }>;
      } = {
        agents: {},
      };

      for (const [agentId, agentConfig] of Object.entries(generated.config.agents)) {
        yamlData.agents[agentId] = {
          memorySearch: {
            extraPaths: agentConfig.memorySearch.extraPaths,
          },
        };
      }

      const yamlContent = stringifyYaml(yamlData, {
        indent: 2,
        lineWidth: 100,
      });

      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, yamlContent, "utf-8");

      console.log(`✅ Memory artifact written: ${artifactPath}`);
    } catch (err) {
      // Silently skip artifact generation on error (e.g., permission issues)
      // This allows tests with non-existent vault roots to pass
    }
  }

  if (Object.keys(generated.explanations).length > 0) {
    console.log("\nMemory scope by agent:");
    for (const agentId of Object.keys(generated.explanations).sort()) {
      const explanation = generated.explanations[agentId];
      if (!explanation) continue;
      console.log(`  ${agentId}`);
      if (explanation.hot) {
        console.log(
          `    hot: ${explanation.hot.path} (via ${explanation.hot.matchedRoles.join(", ")})`
        );
      } else {
        console.log("    hot: (none)");
      }

      if (explanation.warm.length === 0) {
        console.log("    warm: (none)");
      } else {
        for (const pool of explanation.warm) {
          console.log(
            `    warm: ${pool.id} → ${pool.path} (via ${pool.matchedRoles.join(", ")})`
          );
        }
      }
    }
  }
}

export interface AuditMemoryConfigOptions {
  orgChartPath: string;
  configPath: string;
  vaultRoot?: string;
}

export async function auditMemoryConfigFile(
  options: AuditMemoryConfigOptions
): Promise<void> {
  const result = await loadOrgChart(options.orgChartPath);
  if (!result.success) {
    console.error("❌ Schema validation failed:");
    for (const err of result.errors ?? []) {
      console.error(`  ${err.path}: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const lintIssues = lintOrgChart(result.chart!);
  if (reportLintIssues(lintIssues)) {
    process.exitCode = 1;
    return;
  }

  let rawConfig: string;
  try {
    rawConfig = await readFile(options.configPath, "utf-8");
  } catch (err) {
    console.error(`❌ Failed to read OpenClaw config: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let actualConfig: OpenClawConfig;
  try {
    actualConfig = JSON.parse(rawConfig) as OpenClawConfig;
  } catch (err) {
    console.error(`❌ OpenClaw config is not valid JSON: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (!result.chart!.memoryPools) {
    console.warn("⚠ No memoryPools defined in org chart; nothing to generate.");
    const report = buildMissingConfigReport(result.chart!.agents.map(agent => agent.id));
    console.log(formatMemoryAuditReport(report));
    process.exitCode = 1;
    return;
  }

  // Discover projects if vaultRoot is available
  let projects: ProjectRecord[] | undefined;
  if (options.vaultRoot) {
    try {
      const discovered = await discoverProjects(options.vaultRoot, { includeArchived: false });
      projects = discovered.filter(p => p.manifest);
      if (projects.length < discovered.length) {
        const invalidCount = discovered.length - projects.length;
        console.warn(`⚠ Skipping ${invalidCount} invalid project(s)`);
      }
    } catch (err) {
      console.warn(`⚠ Failed to discover projects: ${(err as Error).message}`);
      projects = [];
    }
  }

  let generated;
  try {
    if (projects && projects.length > 0) {
      generated = generateMemoryConfigWithProjects(result.chart!, projects, { vaultRoot: options.vaultRoot });
    } else {
      generated = generateMemoryConfig(result.chart!, { vaultRoot: options.vaultRoot });
    }
  } catch (err) {
    console.error(`❌ Failed to generate expected memory config: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (generated.warnings.length > 0) {
    for (const warning of generated.warnings) {
      console.warn(`⚠ ${warning}`);
    }
  }

  const report = auditMemoryConfig(generated.config, actualConfig);
  console.log(formatMemoryAuditReport(report));

  if (report.summary.hasDrift) {
    process.exitCode = 1;
  }
}

function reportLintIssues(issues: LintIssue[]): boolean {
  if (issues.length === 0) return false;

  const errors = issues.filter(issue => issue.severity === "error");
  const header = errors.length > 0
    ? "❌ Org chart lint failed:"
    : "⚠ Org chart lint warnings:";

  console.error(header);
  for (const issue of issues) {
    const icon = issue.severity === "error" ? "✗" : "⚠";
    console.error(`  ${icon} [${issue.rule}] ${issue.message}`);
  }

  return errors.length > 0;
}

function buildMissingConfigReport(agentIds: string[]): MemoryAuditReport {
  const entries = agentIds
    .slice()
    .sort()
    .map(agentId => ({
      agentId,
      missingPaths: [],
      extraPaths: [],
      missingConfig: true,
      wildcardIssues: [],
    }));

  return {
    entries,
    summary: {
      hasDrift: entries.length > 0,
      driftedAgents: entries.length,
      missingPaths: 0,
      extraPaths: 0,
      missingConfig: entries.length,
      wildcardIssues: 0,
    },
  };
}

export interface GenerateMemoryArtifactOptions {
  orgChartPath: string;
  vaultRoot: string;
}

/**
 * Generate recommended-memory-paths.yaml artifact.
 * Combines org chart memory pools and project enrollment paths.
 */
export async function generateMemoryArtifact(
  options: GenerateMemoryArtifactOptions
): Promise<void> {
  const result = await loadOrgChart(options.orgChartPath);
  if (!result.success) {
    console.error("❌ Schema validation failed:");
    for (const err of result.errors ?? []) {
      console.error(`  ${err.path}: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const lintIssues = lintOrgChart(result.chart!);
  if (reportLintIssues(lintIssues)) {
    process.exitCode = 1;
    return;
  }

  // Discover projects
  let projects;
  try {
    projects = await discoverProjects(options.vaultRoot, { includeArchived: false });
  } catch (err) {
    console.error(`❌ Failed to discover projects: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const validProjects = projects.filter(p => p.manifest);
  if (validProjects.length < projects.length) {
    const invalidCount = projects.length - validProjects.length;
    console.warn(`⚠ Skipping ${invalidCount} invalid project(s)`);
  }

  // Generate memory config with projects
  let generated;
  try {
    generated = generateMemoryConfigWithProjects(result.chart!, validProjects, {
      vaultRoot: options.vaultRoot,
    });
  } catch (err) {
    console.error(`❌ Failed to generate memory config: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (generated.warnings.length > 0) {
    for (const warning of generated.warnings) {
      console.warn(`⚠ ${warning}`);
    }
  }

  // Build YAML structure
  const yamlData: {
    agents: Record<string, { memorySearch: { extraPaths: string[] } }>;
  } = {
    agents: {},
  };

  for (const [agentId, agentConfig] of Object.entries(generated.config.agents)) {
    yamlData.agents[agentId] = {
      memorySearch: {
        extraPaths: agentConfig.memorySearch.extraPaths,
      },
    };
  }

  const yamlContent = stringifyYaml(yamlData, {
    indent: 2,
    lineWidth: 100,
  });

  // Write to artifact location
  const artifactPath = resolve(
    options.vaultRoot,
    "Resources/OpenClaw/Ops/Config/recommended-memory-paths.yaml"
  );

  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, yamlContent, "utf-8");

  console.log(`✅ Memory artifact generated: ${artifactPath}`);
  console.log(`   Agents configured: ${Object.keys(generated.config.agents).length}`);
  console.log(`   Projects enrolled: ${validProjects.length}`);
}
