/**
 * Drift Detector Tests — Compare org chart vs OpenClaw reality
 */

import { describe, it, expect } from "vitest";
import { detectDrift, DriftReport, OpenClawAgent } from "../detector.js";
import { OrgChart } from "../../schemas/org-chart.js";

describe("Drift Detector", () => {
  const makeOrgChart = (agents: Array<{ id: string; name: string; openclawAgentId?: string }>) => {
    return OrgChart.parse({
      schemaVersion: 1,
      agents,
    });
  };

  const makeOpenClawAgents = (agents: Array<{ id: string; name: string; active: boolean }>): OpenClawAgent[] => {
    return agents.map(a => ({
      id: a.id,
      name: a.name,
      active: a.active,
      creature: "agent",
    }));
  };

  describe("no drift", () => {
    it("detects no issues when charts match perfectly", () => {
      const orgChart = makeOrgChart([
        { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        { id: "dev", name: "Dev", openclawAgentId: "agent:dev:main" },
      ]);

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Main", active: true },
        { id: "agent:dev:main", name: "Dev", active: true },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.missing).toHaveLength(0);
      expect(report.extra).toHaveLength(0);
      expect(report.mismatch).toHaveLength(0);
      expect(report.needsPermissionProfile).toHaveLength(0);
    });
  });

  describe("missing agents", () => {
    it("detects agents in org chart but not in OpenClaw", () => {
      const orgChart = makeOrgChart([
        { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        { id: "ghost", name: "Ghost", openclawAgentId: "agent:ghost:main" },
      ]);

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Main", active: true },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.missing).toHaveLength(1);
      expect(report.missing[0]?.agentId).toBe("ghost");
      expect(report.missing[0]?.openclawAgentId).toBe("agent:ghost:main");
    });

    it("does not flag agents without openclawAgentId as missing", () => {
      const orgChart = makeOrgChart([
        { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        { id: "legacy", name: "Legacy" }, // No openclawAgentId
      ]);

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Main", active: true },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.missing).toHaveLength(0);
    });
  });

  describe("extra agents", () => {
    it("detects agents in OpenClaw but not in org chart", () => {
      const orgChart = makeOrgChart([
        { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
      ]);

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Main", active: true },
        { id: "agent:rogue:main", name: "Rogue", active: true },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.extra).toHaveLength(1);
      expect(report.extra[0]?.openclawAgentId).toBe("agent:rogue:main");
    });

    it("does not flag inactive OpenClaw agents as extra", () => {
      const orgChart = makeOrgChart([
        { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
      ]);

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Main", active: true },
        { id: "agent:retired:main", name: "Retired", active: false },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.extra).toHaveLength(0);
    });
  });

  describe("name mismatch", () => {
    it("detects when agent names differ", () => {
      const orgChart = makeOrgChart([
        { id: "main", name: "Main Agent", openclawAgentId: "agent:main:main" },
      ]);

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Different Name", active: true },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.mismatch).toHaveLength(1);
      expect(report.mismatch[0]?.agentId).toBe("main");
      expect(report.mismatch[0]?.field).toBe("name");
      expect(report.mismatch[0]?.orgValue).toBe("Main Agent");
      expect(report.mismatch[0]?.openclawValue).toBe("Different Name");
    });
  });

  describe("needs permission profile", () => {
    it("detects agents with policies but no known permission profile", () => {
      const orgChart = OrgChart.parse({
        schemaVersion: 1,
        agents: [
          {
            id: "main",
            name: "Main",
            openclawAgentId: "agent:main:main",
            policies: {
              memory: {
                scope: ["org", "shared"],
                tiers: ["hot", "warm"],
              },
            },
          },
        ],
      });

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Main", active: true },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.needsPermissionProfile).toHaveLength(1);
      expect(report.needsPermissionProfile[0]?.agentId).toBe("main");
      expect(report.needsPermissionProfile[0]?.reason).toContain("memory policy");
    });

    it("does not flag agents without policies", () => {
      const orgChart = makeOrgChart([
        { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
      ]);

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Main", active: true },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.needsPermissionProfile).toHaveLength(0);
    });
  });

  describe("report summary", () => {
    it("provides actionable summary when drift detected", () => {
      const orgChart = makeOrgChart([
        { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        { id: "missing", name: "Missing", openclawAgentId: "agent:missing:main" },
      ]);

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Main", active: true },
        { id: "agent:extra:main", name: "Extra", active: true },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.summary.totalIssues).toBe(2);
      expect(report.summary.hasDrift).toBe(true);
      expect(report.summary.categories.missing).toBe(1);
      expect(report.summary.categories.extra).toBe(1);
    });

    it("reports no drift when everything matches", () => {
      const orgChart = makeOrgChart([
        { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
      ]);

      const openclawAgents = makeOpenClawAgents([
        { id: "agent:main:main", name: "Main", active: true },
      ]);

      const report = detectDrift(orgChart, openclawAgents);
      
      expect(report.summary.totalIssues).toBe(0);
      expect(report.summary.hasDrift).toBe(false);
    });
  });
});
