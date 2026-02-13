/**
 * Drift Detector — Compare org chart vs OpenClaw agent reality
 * 
 * Detects:
 * - Missing: agents in org chart but not in OpenClaw
 * - Extra: agents in OpenClaw but not in org chart
 * - Mismatch: agents exist in both but with different properties
 * - Needs permission profile: agents with policies but no profile
 */

import type { OrgChart, OrgAgent } from "../schemas/org-chart.js";

/** OpenClaw agent representation (from `openclaw agents list --json`) */
export interface OpenClawAgent {
  id: string;
  name: string;
  creature: string;
  active: boolean;
}

/** Missing agent (in org chart but not OpenClaw) */
export interface MissingAgent {
  agentId: string;
  name: string;
  openclawAgentId: string;
}

/** Extra agent (in OpenClaw but not org chart) */
export interface ExtraAgent {
  openclawAgentId: string;
  name: string;
}

/** Mismatch (agent exists in both but properties differ) */
export interface AgentMismatch {
  agentId: string;
  openclawAgentId: string;
  field: string;
  orgValue: string;
  openclawValue: string;
}

/** Needs permission profile */
export interface NeedsPermissionProfile {
  agentId: string;
  openclawAgentId: string;
  reason: string;
}

/** Drift report */
export interface DriftReport {
  missing: MissingAgent[];
  extra: ExtraAgent[];
  mismatch: AgentMismatch[];
  needsPermissionProfile: NeedsPermissionProfile[];
  summary: {
    totalIssues: number;
    hasDrift: boolean;
    categories: {
      missing: number;
      extra: number;
      mismatch: number;
      needsPermissionProfile: number;
    };
  };
}

/**
 * Detect drift between org chart and OpenClaw agent list
 */
export function detectDrift(orgChart: OrgChart, openclawAgents: OpenClawAgent[]): DriftReport {
  const missing: MissingAgent[] = [];
  const extra: ExtraAgent[] = [];
  const mismatch: AgentMismatch[] = [];
  const needsPermissionProfile: NeedsPermissionProfile[] = [];

  // Build lookup maps
  const openclawMap = new Map<string, OpenClawAgent>();
  for (const agent of openclawAgents) {
    openclawMap.set(agent.id, agent);
  }

  const orgAgentMap = new Map<string, OrgAgent>();
  for (const agent of orgChart.agents) {
    if (agent.openclawAgentId) {
      orgAgentMap.set(agent.openclawAgentId, agent);
    }
  }

  // Detect missing agents (in org chart but not OpenClaw)
  for (const orgAgent of orgChart.agents) {
    if (!orgAgent.openclawAgentId) {
      // Skip agents without openclawAgentId (can't map them)
      continue;
    }

    const openclawAgent = openclawMap.get(orgAgent.openclawAgentId);
    if (!openclawAgent) {
      missing.push({
        agentId: orgAgent.id,
        name: orgAgent.name,
        openclawAgentId: orgAgent.openclawAgentId,
      });
    }
  }

  // Detect extra agents (in OpenClaw but not org chart) and mismatches
  for (const openclawAgent of openclawAgents) {
    // Skip inactive agents
    if (!openclawAgent.active) {
      continue;
    }

    const orgAgent = orgAgentMap.get(openclawAgent.id);
    
    if (!orgAgent) {
      // Agent in OpenClaw but not in org chart
      extra.push({
        openclawAgentId: openclawAgent.id,
        name: openclawAgent.name,
      });
    } else {
      // Agent exists in both - check for mismatches
      if (orgAgent.name !== openclawAgent.name) {
        mismatch.push({
          agentId: orgAgent.id,
          openclawAgentId: openclawAgent.id,
          field: "name",
          orgValue: orgAgent.name,
          openclawValue: openclawAgent.name,
        });
      }
    }
  }

  // Detect agents needing permission profiles
  for (const orgAgent of orgChart.agents) {
    if (!orgAgent.openclawAgentId) continue;

    const hasPolicies = orgAgent.policies && (
      orgAgent.policies.memory ||
      orgAgent.policies.communication ||
      orgAgent.policies.tasking
    );

    if (hasPolicies) {
      const reasons: string[] = [];
      if (orgAgent.policies?.memory) {
        reasons.push("memory policy defined");
      }
      if (orgAgent.policies?.communication) {
        reasons.push("communication policy defined");
      }
      if (orgAgent.policies?.tasking) {
        reasons.push("tasking policy defined");
      }

      needsPermissionProfile.push({
        agentId: orgAgent.id,
        openclawAgentId: orgAgent.openclawAgentId,
        reason: reasons.join(", "),
      });
    }
  }

  // Build summary
  const totalIssues = missing.length + extra.length + mismatch.length + needsPermissionProfile.length;

  return {
    missing,
    extra,
    mismatch,
    needsPermissionProfile,
    summary: {
      totalIssues,
      hasDrift: totalIssues > 0,
      categories: {
        missing: missing.length,
        extra: extra.length,
        mismatch: mismatch.length,
        needsPermissionProfile: needsPermissionProfile.length,
      },
    },
  };
}
