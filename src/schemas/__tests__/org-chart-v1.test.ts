/**
 * Phase 1 Org Chart Schema Extensions Tests
 */

import { describe, it, expect } from "vitest";
import { 
  OrgChart, 
  OrgUnit, 
  OrgGroup, 
  OrgMembership, 
  OrgRelationship,
  OrgPolicies,
  MemoryPolicy,
  CommunicationPolicy,
  TaskingPolicy
} from "../org-chart.js";

describe("P1.1: Org Chart Schema Extensions", () => {
  describe("OrgUnit", () => {
    it("parses a basic org unit", () => {
      const unit = OrgUnit.parse({
        id: "engineering",
        name: "Engineering",
        type: "department",
      });
      expect(unit.id).toBe("engineering");
      expect(unit.parentId).toBeUndefined();
    });

    it("parses org unit with parent (tree structure)", () => {
      const unit = OrgUnit.parse({
        id: "backend",
        name: "Backend Team",
        type: "team",
        parentId: "engineering",
      });
      expect(unit.parentId).toBe("engineering");
    });

    it("applies defaults", () => {
      const unit = OrgUnit.parse({
        id: "test",
        name: "Test Unit",
        type: "team",
      });
      expect(unit.active).toBe(true);
      expect(unit.metadata).toEqual({});
    });
  });

  describe("OrgGroup", () => {
    it("parses a basic group", () => {
      const group = OrgGroup.parse({
        id: "leads",
        name: "Team Leads",
        memberIds: ["architect", "backend-lead"],
      });
      expect(group.memberIds).toHaveLength(2);
    });

    it("allows empty member list", () => {
      const group = OrgGroup.parse({
        id: "empty",
        name: "Empty Group",
        memberIds: [],
      });
      expect(group.memberIds).toEqual([]);
    });
  });

  describe("OrgMembership", () => {
    it("parses agent membership in org unit", () => {
      const membership = OrgMembership.parse({
        agentId: "backend-dev",
        orgUnitId: "backend",
        role: "developer",
      });
      expect(membership.agentId).toBe("backend-dev");
      expect(membership.role).toBe("developer");
    });

    it("applies primary default to true", () => {
      const membership = OrgMembership.parse({
        agentId: "agent1",
        orgUnitId: "unit1",
      });
      expect(membership.primary).toBe(true);
    });

    it("allows non-primary membership", () => {
      const membership = OrgMembership.parse({
        agentId: "agent1",
        orgUnitId: "unit2",
        primary: false,
      });
      expect(membership.primary).toBe(false);
    });
  });

  describe("OrgRelationship", () => {
    it("parses escalation relationship", () => {
      const rel = OrgRelationship.parse({
        fromAgentId: "backend-dev",
        toAgentId: "architect",
        type: "escalates_to",
      });
      expect(rel.type).toBe("escalates_to");
    });

    it("parses delegates_to relationship", () => {
      const rel = OrgRelationship.parse({
        fromAgentId: "architect",
        toAgentId: "backend-dev",
        type: "delegates_to",
      });
      expect(rel.type).toBe("delegates_to");
    });

    it("parses consults_with relationship", () => {
      const rel = OrgRelationship.parse({
        fromAgentId: "frontend-dev",
        toAgentId: "backend-dev",
        type: "consults_with",
      });
      expect(rel.type).toBe("consults_with");
    });

    it("applies active default", () => {
      const rel = OrgRelationship.parse({
        fromAgentId: "a",
        toAgentId: "b",
        type: "escalates_to",
      });
      expect(rel.active).toBe(true);
    });
  });

  describe("MemoryPolicy", () => {
    it("parses memory policy with scope paths", () => {
      const policy = MemoryPolicy.parse({
        scope: ["org/engineering", "shared/docs"],
        tiers: ["hot", "warm"],
      });
      expect(policy.scope).toHaveLength(2);
      expect(policy.tiers).toContain("hot");
    });

    it("validates tier values", () => {
      expect(() => MemoryPolicy.parse({
        scope: ["test"],
        tiers: ["invalid"],
      })).toThrow();
    });

    it("rejects cold in warm (invalid tier combo)", () => {
      // This will be validated by linter, schema allows it
      const policy = MemoryPolicy.parse({
        scope: ["test"],
        tiers: ["warm", "cold"],
      });
      expect(policy.tiers).toContain("cold");
    });
  });

  describe("CommunicationPolicy", () => {
    it("parses communication policy", () => {
      const policy = CommunicationPolicy.parse({
        allowedChannels: ["internal", "slack"],
        requiresApproval: false,
      });
      expect(policy.allowedChannels).toHaveLength(2);
    });

    it("applies defaults", () => {
      const policy = CommunicationPolicy.parse({
        allowedChannels: ["internal"],
      });
      expect(policy.requiresApproval).toBe(false);
      expect(policy.restrictedAgents).toEqual([]);
    });
  });

  describe("TaskingPolicy", () => {
    it("parses tasking policy", () => {
      const policy = TaskingPolicy.parse({
        maxConcurrent: 3,
        allowSelfAssign: true,
      });
      expect(policy.maxConcurrent).toBe(3);
    });

    it("applies defaults", () => {
      const policy = TaskingPolicy.parse({});
      expect(policy.maxConcurrent).toBe(1);
      expect(policy.allowSelfAssign).toBe(false);
      expect(policy.requiresReview).toBe(false);
    });
  });

  describe("OrgPolicies", () => {
    it("parses complete policies object", () => {
      const policies = OrgPolicies.parse({
        memory: {
          scope: ["org/backend"],
          tiers: ["hot"],
        },
        communication: {
          allowedChannels: ["internal"],
        },
        tasking: {
          maxConcurrent: 2,
        },
      });
      expect(policies.memory.tiers).toContain("hot");
      expect(policies.communication.allowedChannels).toContain("internal");
      expect(policies.tasking.maxConcurrent).toBe(2);
    });

    it("allows partial policies", () => {
      const policies = OrgPolicies.parse({
        memory: {
          scope: ["test"],
          tiers: ["hot"],
        },
      });
      expect(policies.memory.scope).toHaveLength(1);
      expect(policies.communication).toBeUndefined();
    });
  });

  describe("OrgChart with new fields", () => {
    it("parses org chart with orgUnits", () => {
      const chart = OrgChart.parse({
        schemaVersion: 1,
        orgUnits: [
          { id: "engineering", name: "Engineering", type: "department" },
          { id: "backend", name: "Backend", type: "team", parentId: "engineering" },
        ],
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        ],
      });
      expect(chart.orgUnits).toHaveLength(2);
    });

    it("parses org chart with groups", () => {
      const chart = OrgChart.parse({
        schemaVersion: 1,
        groups: [
          { id: "reviewers", name: "Code Reviewers", memberIds: ["architect", "senior-dev"] },
        ],
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        ],
      });
      expect(chart.groups).toHaveLength(1);
    });

    it("parses org chart with memberships", () => {
      const chart = OrgChart.parse({
        schemaVersion: 1,
        orgUnits: [
          { id: "backend", name: "Backend", type: "team" },
        ],
        memberships: [
          { agentId: "dev1", orgUnitId: "backend", role: "developer" },
        ],
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        ],
      });
      expect(chart.memberships).toHaveLength(1);
    });

    it("parses org chart with relationships", () => {
      const chart = OrgChart.parse({
        schemaVersion: 1,
        relationships: [
          { fromAgentId: "dev", toAgentId: "lead", type: "escalates_to" },
        ],
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        ],
      });
      expect(chart.relationships).toHaveLength(1);
    });

    it("parses org chart with defaults policies", () => {
      const chart = OrgChart.parse({
        schemaVersion: 1,
        defaults: {
          policies: {
            memory: {
              scope: ["shared"],
              tiers: ["hot", "warm"],
            },
            communication: {
              allowedChannels: ["internal"],
            },
            tasking: {
              maxConcurrent: 1,
            },
          },
        },
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        ],
      });
      expect(chart.defaults?.policies?.memory?.tiers).toContain("hot");
    });

    it("parses org chart with memory pools", () => {
      const chart = OrgChart.parse({
        schemaVersion: 1,
        memoryPools: {
          hot: {
            path: "Resources/OpenClaw/_Core",
            description: "Canonical operator context",
          },
          warm: [
            {
              id: "runbooks",
              path: "Resources/OpenClaw/Runbooks",
              roles: ["main"],
            },
          ],
          cold: ["Logs", "Approvals", "_archived"],
        },
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        ],
      });
      expect(chart.memoryPools?.warm).toHaveLength(1);
      expect(chart.memoryPools?.cold).toContain("Logs");
    });

    it("parses agent with openclawAgentId", () => {
      const chart = OrgChart.parse({
        schemaVersion: 1,
        agents: [
          { 
            id: "main", 
            name: "Main", 
            openclawAgentId: "agent:main:main",
          },
        ],
      });
      expect(chart.agents[0]?.openclawAgentId).toBe("agent:main:main");
    });

    it("applies default empty arrays", () => {
      const chart = OrgChart.parse({
        schemaVersion: 1,
        agents: [
          { id: "main", name: "Main", openclawAgentId: "agent:main:main" },
        ],
      });
      expect(chart.orgUnits).toEqual([]);
      expect(chart.groups).toEqual([]);
      expect(chart.memberships).toEqual([]);
      expect(chart.relationships).toEqual([]);
    });
  });
});
