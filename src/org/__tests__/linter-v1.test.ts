/**
 * Phase 1 Linter Tests — New validation rules
 */

import { describe, it, expect } from "vitest";
import { lintOrgChart } from "../linter.js";
import { OrgChart } from "../../schemas/org-chart.js";

function makeChartV1(overrides: Record<string, unknown> = {}): ReturnType<typeof OrgChart.parse> {
  return OrgChart.parse({
    schemaVersion: 1,
    agents: [
      { id: "main", name: "Main", openclawAgentId: "agent:main:main", active: true },
    ],
    ...overrides,
  });
}

describe("P1.1: Linter validations", () => {
  describe("tree structure (single root)", () => {
    it("allows single root org unit", () => {
      const chart = makeChartV1({
        orgUnits: [
          { id: "root", name: "Root", type: "department" },
          { id: "child1", name: "Child 1", type: "team", parentId: "root" },
          { id: "child2", name: "Child 2", type: "team", parentId: "root" },
        ],
      });
      const issues = lintOrgChart(chart);
      const errors = issues.filter(i => i.severity === "error" && i.rule === "single-root");
      expect(errors).toHaveLength(0);
    });

    it("detects multiple root org units", () => {
      const chart = makeChartV1({
        orgUnits: [
          { id: "root1", name: "Root 1", type: "department" },
          { id: "root2", name: "Root 2", type: "department" },
          { id: "child", name: "Child", type: "team", parentId: "root1" },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "single-root" && i.severity === "error")).toBe(true);
    });

    it("allows no org units (empty tree)", () => {
      const chart = makeChartV1({ orgUnits: [] });
      const issues = lintOrgChart(chart);
      const errors = issues.filter(i => i.rule === "single-root");
      expect(errors).toHaveLength(0);
    });
  });

  describe("parentId exists", () => {
    it("detects orgUnit with invalid parentId", () => {
      const chart = makeChartV1({
        orgUnits: [
          { id: "root", name: "Root", type: "department" },
          { id: "child", name: "Child", type: "team", parentId: "nonexistent" },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "valid-parent-id")).toBe(true);
    });

    it("allows valid parentId references", () => {
      const chart = makeChartV1({
        orgUnits: [
          { id: "root", name: "Root", type: "department" },
          { id: "child", name: "Child", type: "team", parentId: "root" },
        ],
      });
      const issues = lintOrgChart(chart);
      const errors = issues.filter(i => i.rule === "valid-parent-id");
      expect(errors).toHaveLength(0);
    });
  });

  describe("duplicate IDs", () => {
    it("detects duplicate org unit IDs", () => {
      const chart = makeChartV1({
        orgUnits: [
          { id: "duplicate", name: "First", type: "team" },
          { id: "duplicate", name: "Second", type: "team" },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "unique-org-unit-id")).toBe(true);
    });

    it("detects duplicate group IDs", () => {
      const chart = makeChartV1({
        groups: [
          { id: "dup", name: "Group 1", memberIds: [] },
          { id: "dup", name: "Group 2", memberIds: [] },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "unique-group-id")).toBe(true);
    });
  });

  describe("membership refs", () => {
    it("detects membership with invalid agentId", () => {
      const chart = makeChartV1({
        orgUnits: [
          { id: "unit1", name: "Unit 1", type: "team" },
        ],
        memberships: [
          { agentId: "ghost", orgUnitId: "unit1", role: "dev" },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "valid-membership-agent")).toBe(true);
    });

    it("detects membership with invalid orgUnitId", () => {
      const chart = makeChartV1({
        memberships: [
          { agentId: "main", orgUnitId: "nonexistent", role: "dev" },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "valid-membership-unit")).toBe(true);
    });

    it("detects group with invalid member IDs", () => {
      const chart = makeChartV1({
        groups: [
          { id: "group1", name: "Group 1", memberIds: ["main", "ghost", "phantom"] },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "valid-group-members")).toBe(true);
    });

    it("allows valid memberships", () => {
      const chart = makeChartV1({
        orgUnits: [
          { id: "unit1", name: "Unit 1", type: "team" },
        ],
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
          { id: "dev1", name: "Dev 1", openclawAgentId: "agent:dev1:main" },
        ],
        memberships: [
          { agentId: "main", orgUnitId: "unit1", role: "lead" },
          { agentId: "dev1", orgUnitId: "unit1", role: "dev" },
        ],
      });
      const issues = lintOrgChart(chart);
      const errors = issues.filter(i => 
        i.rule === "valid-membership-agent" || i.rule === "valid-membership-unit"
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe("agent.openclawAgentId presence (warn)", () => {
    it("warns when agent is missing openclawAgentId", () => {
      const chart = makeChartV1({
        agents: [
          { id: "main", name: "Main", active: true },
          { id: "dev1", name: "Dev 1", openclawAgentId: "agent:dev1:main" },
        ],
      });
      const issues = lintOrgChart(chart);
      const warnings = issues.filter(i => 
        i.rule === "missing-openclaw-agent-id" && i.severity === "warning"
      );
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some(w => w.message.includes("main"))).toBe(true);
    });

    it("does not warn when all agents have openclawAgentId", () => {
      const chart = makeChartV1({
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
          { id: "dev1", name: "Dev 1", openclawAgentId: "agent:dev1:main" },
        ],
      });
      const issues = lintOrgChart(chart);
      const warnings = issues.filter(i => i.rule === "missing-openclaw-agent-id");
      expect(warnings).toHaveLength(0);
    });
  });

  describe("circular escalation loops", () => {
    it("detects circular escalation via escalates_to relationships", () => {
      const chart = makeChartV1({
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
          { id: "a", name: "A", openclawAgentId: "agent:a:main" },
          { id: "b", name: "B", openclawAgentId: "agent:b:main" },
          { id: "c", name: "C", openclawAgentId: "agent:c:main" },
        ],
        relationships: [
          { fromAgentId: "a", toAgentId: "b", type: "escalates_to" },
          { fromAgentId: "b", toAgentId: "c", type: "escalates_to" },
          { fromAgentId: "c", toAgentId: "a", type: "escalates_to" },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "no-circular-escalation")).toBe(true);
    });

    it("allows non-circular escalation chains", () => {
      const chart = makeChartV1({
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
          { id: "a", name: "A", openclawAgentId: "agent:a:main" },
          { id: "b", name: "B", openclawAgentId: "agent:b:main" },
        ],
        relationships: [
          { fromAgentId: "a", toAgentId: "b", type: "escalates_to" },
          { fromAgentId: "b", toAgentId: "main", type: "escalates_to" },
        ],
      });
      const issues = lintOrgChart(chart);
      const errors = issues.filter(i => i.rule === "no-circular-escalation");
      expect(errors).toHaveLength(0);
    });

    it("detects self-escalation", () => {
      const chart = makeChartV1({
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        ],
        relationships: [
          { fromAgentId: "main", toAgentId: "main", type: "escalates_to" },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "no-self-escalation")).toBe(true);
    });
  });

  describe("memory tier path validation", () => {
    it("detects cold tier alongside warm tier (invalid combo)", () => {
      const chart = makeChartV1({
        agents: [
          { 
            id: "main", 
            name: "Main", 
            openclawAgentId: "agent:main:main",
            policies: {
              memory: {
                scope: ["test"],
                tiers: ["warm", "cold"],
              },
            },
          },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "no-cold-in-warm")).toBe(true);
    });

    it("allows hot+warm tier combo", () => {
      const chart = makeChartV1({
        agents: [
          { 
            id: "main", 
            name: "Main", 
            openclawAgentId: "agent:main:main",
            policies: {
              memory: {
                scope: ["test"],
                tiers: ["hot", "warm"],
              },
            },
          },
        ],
      });
      const issues = lintOrgChart(chart);
      const errors = issues.filter(i => i.rule === "no-cold-in-warm");
      expect(errors).toHaveLength(0);
    });

    it("allows cold-only tier", () => {
      const chart = makeChartV1({
        agents: [
          { 
            id: "main", 
            name: "Main", 
            openclawAgentId: "agent:main:main",
            policies: {
              memory: {
                scope: ["test"],
                tiers: ["cold"],
              },
            },
          },
        ],
      });
      const issues = lintOrgChart(chart);
      const errors = issues.filter(i => i.rule === "no-cold-in-warm");
      expect(errors).toHaveLength(0);
    });

    it("validates memory tier paths in defaults", () => {
      const chart = makeChartV1({
        defaults: {
          policies: {
            memory: {
              scope: ["shared"],
              tiers: ["hot", "warm", "cold"],
            },
          },
        },
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "no-cold-in-warm")).toBe(true);
    });
  });

  describe("memory pool validations", () => {
    it("allows valid memory pools", () => {
      const chart = makeChartV1({
        memoryPools: {
          hot: {
            path: "Resources/OpenClaw/_Core",
          },
          warm: [
            {
              id: "runbooks",
              path: "Resources/OpenClaw/Runbooks",
              roles: ["main", "swe-*"],
            },
          ],
          cold: ["Logs", "Approvals", "_archived"],
        },
      });
      const issues = lintOrgChart(chart);
      const errors = issues.filter(i => i.severity === "error");
      expect(errors).toHaveLength(0);
    });

    it("detects duplicate warm pool IDs", () => {
      const chart = makeChartV1({
        memoryPools: {
          hot: {
            path: "Resources/OpenClaw/_Core",
          },
          warm: [
            {
              id: "runbooks",
              path: "Resources/OpenClaw/Runbooks",
              roles: ["main"],
            },
            {
              id: "runbooks",
              path: "Resources/OpenClaw/Ops",
              roles: ["main"],
            },
          ],
          cold: ["Logs"],
        },
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "unique-memory-pool-id")).toBe(true);
    });

    it("detects duplicate memory pool paths", () => {
      const chart = makeChartV1({
        memoryPools: {
          hot: {
            path: "Resources/OpenClaw/_Core",
          },
          warm: [
            {
              id: "runbooks",
              path: "Resources/OpenClaw/Runbooks",
              roles: ["main"],
            },
            {
              id: "runbooks-dup",
              path: "Resources/OpenClaw/Runbooks",
              roles: ["main"],
            },
          ],
          cold: ["Logs"],
        },
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "unique-memory-pool-path")).toBe(true);
    });

    it("detects unknown memory pool roles", () => {
      const chart = makeChartV1({
        memoryPools: {
          hot: {
            path: "Resources/OpenClaw/_Core",
          },
          warm: [
            {
              id: "runbooks",
              path: "Resources/OpenClaw/Runbooks",
              roles: ["ghost"],
            },
          ],
          cold: ["Logs"],
        },
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "valid-memory-pool-role")).toBe(true);
    });

    it("detects cold path substrings in pools", () => {
      const chart = makeChartV1({
        memoryPools: {
          hot: {
            path: "Resources/OpenClaw/_Core",
          },
          warm: [
            {
              id: "logs",
              path: "Resources/OpenClaw/Logs",
              roles: ["main"],
            },
          ],
          cold: ["Logs"],
        },
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "no-cold-paths-in-pools")).toBe(true);
    });
  });

  describe("relationship validations", () => {
    it("detects relationships with invalid fromAgentId", () => {
      const chart = makeChartV1({
        relationships: [
          { fromAgentId: "ghost", toAgentId: "main", type: "escalates_to" },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "valid-relationship-from")).toBe(true);
    });

    it("detects relationships with invalid toAgentId", () => {
      const chart = makeChartV1({
        relationships: [
          { fromAgentId: "main", toAgentId: "ghost", type: "escalates_to" },
        ],
      });
      const issues = lintOrgChart(chart);
      expect(issues.some(i => i.rule === "valid-relationship-to")).toBe(true);
    });
  });
});
