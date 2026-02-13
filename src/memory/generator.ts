import { isAbsolute, resolve as resolvePath, join } from "node:path";
import type { OrgChart } from "../schemas/org-chart.js";
import type { ProjectRecord } from "../projects/registry.js";

/**
 * Generated memorySearch config keyed by agent id.
 */
export interface MemoryConfig {
  agents: Record<string, { memorySearch: { extraPaths: string[] } }>;
}

/**
 * Matching pool metadata for a single agent.
 */
export interface PoolMatch {
  id: string;
  path: string;
  matchedRoles: string[];
}

/**
 * Per-agent explanation of hot/warm pool inclusion.
 */
export interface AgentMemoryExplanation {
  hot: PoolMatch | null;
  warm: PoolMatch[];
}

/**
 * Output of memory config generation.
 */
export interface MemoryConfigResult {
  config: MemoryConfig;
  explanations: Record<string, AgentMemoryExplanation>;
  warnings: string[];
}

/**
 * Options for memory config generation.
 */
export interface MemoryConfigOptions {
  vaultRoot?: string;
}

/**
 * Build memorySearch config from org chart memoryPools.
 */
export function generateMemoryConfig(
  chart: OrgChart,
  options: MemoryConfigOptions = {}
): MemoryConfigResult {
  const warnings: string[] = [];
  const config: MemoryConfig = { agents: {} };
  const explanations: Record<string, AgentMemoryExplanation> = {};

  if (!chart.memoryPools) {
    warnings.push("No memoryPools defined in org chart; nothing to generate.");
    return { config, explanations, warnings };
  }

  const agentIds = chart.agents.map(agent => agent.id).sort();

  const hotPatterns = chart.memoryPools.hot.agents ?? ["all"];
  const resolvedHotPath = resolvePoolPath(chart.memoryPools.hot.path, options.vaultRoot);

  const warmPools = chart.memoryPools.warm.map(pool => ({
    ...pool,
    resolvedPath: resolvePoolPath(pool.path, options.vaultRoot),
  }));

  for (const agentId of agentIds) {
    const seen = new Set<string>();
    const extraPaths: string[] = [];

    const addPath = (path: string) => {
      if (!seen.has(path)) {
        seen.add(path);
        extraPaths.push(path);
      }
    };

    const hotMatches = matchedRoles(agentId, hotPatterns);
    const explanation: AgentMemoryExplanation = {
      hot: hotMatches.length > 0
        ? { id: "hot", path: resolvedHotPath, matchedRoles: hotMatches }
        : null,
      warm: [],
    };

    if (hotMatches.length > 0) {
      addPath(resolvedHotPath);
    }

    for (const pool of warmPools) {
      const warmMatches = matchedRoles(agentId, pool.roles);
      if (warmMatches.length === 0) continue;
      addPath(pool.resolvedPath);
      explanation.warm.push({
        id: pool.id,
        path: pool.resolvedPath,
        matchedRoles: warmMatches,
      });
    }

    if (extraPaths.length > 0) {
      config.agents[agentId] = {
        memorySearch: {
          extraPaths,
        },
      };
      explanations[agentId] = explanation;
    }
  }

  return { config, explanations, warnings };
}

/**
 * Resolve a pool path to an absolute path using the vault root.
 */
export function resolvePoolPath(path: string, vaultRoot?: string): string {
  if (isAbsolute(path)) return path;
  if (!vaultRoot) {
    throw new Error(`vaultRoot is required to resolve relative path '${path}'`);
  }
  return resolvePath(vaultRoot, path);
}

function matchedRoles(agentId: string, patterns: string[]): string[] {
  const matches: string[] = [];

  for (const pattern of patterns) {
    if (pattern === "all") {
      matches.push(pattern);
      continue;
    }

    if (pattern.includes("*")) {
      const regex = wildcardToRegex(pattern);
      if (regex.test(agentId)) matches.push(pattern);
      continue;
    }

    if (pattern === agentId) {
      matches.push(pattern);
    }
  }

  return matches;
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = `^${escaped.replace(/\*/g, ".*")}$`;
  return new RegExp(regex);
}

/**
 * Generate memory config including project enrollment paths.
 * Combines org chart memory pools with project-specific warm paths.
 */
export function generateMemoryConfigWithProjects(
  chart: OrgChart,
  projects: ProjectRecord[],
  options: MemoryConfigOptions = {}
): MemoryConfigResult {
  // Check vaultRoot early to avoid errors from generateMemoryConfig
  if (!options.vaultRoot) {
    const emptyResult: MemoryConfigResult = {
      config: { agents: {} },
      explanations: {},
      warnings: ["vaultRoot required for memory config generation"],
    };
    return emptyResult;
  }

  // Start with org chart pools
  const result = generateMemoryConfig(chart, options);

  const agentTeams = buildAgentTeamMap(chart);

  // Add project enrollment paths
  for (const project of projects) {
    if (!project.manifest) continue;

    const { manifest } = project;
    const warmPaths = manifest.memory.allowIndex.warmPaths;

    // Determine enrolled agents
    const enrolledAgents = getEnrolledAgents(manifest, agentTeams);

    for (const agentId of enrolledAgents) {
      // Initialize config if not present
      if (!result.config.agents[agentId]) {
        result.config.agents[agentId] = { memorySearch: { extraPaths: [] } };
        result.explanations[agentId] = { hot: null, warm: [] };
      }

      const extraPaths = result.config.agents[agentId].memorySearch.extraPaths;
      const seen = new Set(extraPaths);

      // Add warm paths from project
      for (const warmPath of warmPaths) {
        const absolutePath = join(
          options.vaultRoot,
          "Projects",
          project.id,
          warmPath
        );
        if (!seen.has(absolutePath)) {
          extraPaths.push(absolutePath);
          seen.add(absolutePath);
        }
      }
    }
  }

  // Sort paths for deterministic output
  for (const agentId of Object.keys(result.config.agents)) {
    const agentConfig = result.config.agents[agentId];
    if (agentConfig) {
      agentConfig.memorySearch.extraPaths.sort();
    }
  }

  return result;
}

/**
 * Build map of agent ID to team membership.
 */
function buildAgentTeamMap(chart: OrgChart): Map<string, string | undefined> {
  const teamMap = new Map<string, string | undefined>();
  for (const agent of chart.agents) {
    teamMap.set(agent.id, agent.team);
  }
  return teamMap;
}

/**
 * Determine which agents are enrolled in a project.
 * Enrolled if: agent in participants OR agent.team matches owner.team.
 */
function getEnrolledAgents(
  manifest: { owner: { team: string }; participants: string[] },
  agentTeams: Map<string, string | undefined>
): string[] {
  const enrolled = new Set<string>();

  // Add explicit participants
  for (const participantId of manifest.participants) {
    enrolled.add(participantId);
  }

  // Add agents from owner team
  for (const [agentId, team] of agentTeams) {
    if (team === manifest.owner.team) {
      enrolled.add(agentId);
    }
  }

  return Array.from(enrolled).sort();
}
