import { describe, it, expect } from "vitest";
import { OrgChart, OrgAgent } from "../org-chart.js";

describe("OrgChart", () => {
  const minimalChart = {
    schemaVersion: 1,
    agents: [
      { id: "main", name: "Demerzel" },
    ],
  };

  it("parses a minimal org chart", () => {
    const result = OrgChart.safeParse(minimalChart);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents).toHaveLength(1);
      expect(result.data.teams).toEqual([]);
      expect(result.data.routing).toEqual([]);
    }
  });

  it("parses a full org chart", () => {
    const full = {
      schemaVersion: 1,
      template: "swe-team",
      teams: [
        { id: "swe-suite", name: "SWE Suite", lead: "swe-architect" },
      ],
      agents: [
        {
          id: "main",
          name: "Demerzel",
          canDelegate: true,
          capabilities: { tags: ["orchestration", "ops"], concurrency: 3 },
          comms: { preferred: "send", sessionKey: "agent:main:main" },
        },
        {
          id: "swe-architect",
          name: "Architect",
          team: "swe-suite",
          reportsTo: "main",
          canDelegate: true,
          capabilities: { tags: ["architecture", "design"], model: "openai-api/gpt-5.2-codex" },
        },
      ],
      routing: [
        { matchTags: ["architecture"], targetRole: "swe-architect", weight: 10 },
        { matchTags: ["backend"], targetTeam: "swe-suite", weight: 50 },
      ],
    };

    const result = OrgChart.safeParse(full);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.template).toBe("swe-team");
      expect(result.data.agents).toHaveLength(2);
      expect(result.data.teams).toHaveLength(1);
      expect(result.data.routing).toHaveLength(2);
    }
  });

  it("rejects missing agents", () => {
    expect(OrgChart.safeParse({ schemaVersion: 1 }).success).toBe(false);
  });

  it("rejects invalid schema version", () => {
    expect(OrgChart.safeParse({ ...minimalChart, schemaVersion: 99 }).success).toBe(false);
  });
});

describe("OrgAgent", () => {
  it("applies defaults", () => {
    const agent = OrgAgent.parse({ id: "test", name: "Test Agent" });
    expect(agent.active).toBe(true);
    expect(agent.canDelegate).toBe(false);
    expect(agent.capabilities.concurrency).toBe(1);
    expect(agent.capabilities.tags).toEqual([]);
    expect(agent.comms.preferred).toBe("send");
    expect(agent.comms.fallbacks).toEqual(["send", "cli"]);
  });

  it("accepts context budget policy", () => {
    const agent = OrgAgent.parse({
      id: "test",
      name: "Test Agent",
      policies: {
        context: {
          target: 10000,
          warn: 20000,
          critical: 30000,
        },
      },
    });

    expect(agent.policies?.context).toEqual({
      target: 10000,
      warn: 20000,
      critical: 30000,
    });
  });

  it("allows agents without context policy (backward compatible)", () => {
    const agent = OrgAgent.parse({
      id: "test",
      name: "Test Agent",
    });

    expect(agent.policies?.context).toBeUndefined();
  });

  it("rejects invalid context policy (missing fields)", () => {
    const result = OrgAgent.safeParse({
      id: "test",
      name: "Test Agent",
      policies: {
        context: {
          target: 10000,
          warn: 20000,
          // missing critical
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid context policy (negative values)", () => {
    const result = OrgAgent.safeParse({
      id: "test",
      name: "Test Agent",
      policies: {
        context: {
          target: -100,
          warn: 20000,
          critical: 30000,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("OrgChart with context budget policy", () => {
  it("accepts default policies with context budget", () => {
    const chart = OrgChart.parse({
      schemaVersion: 1,
      defaults: {
        policies: {
          context: {
            target: 15000,
            warn: 25000,
            critical: 35000,
          },
        },
      },
      agents: [
        { id: "main", name: "Demerzel" },
      ],
    });

    expect(chart.defaults?.policies?.context).toEqual({
      target: 15000,
      warn: 25000,
      critical: 35000,
    });
  });
});

describe("OrgChart with memory curation", () => {
  it("accepts memoryCuration configuration", () => {
    const chart = OrgChart.parse({
      schemaVersion: 1,
      memoryCuration: {
        policyPath: "policies/curation-policy.yaml",
        role: "memory-curator",
      },
      agents: [
        { id: "main", name: "Demerzel" },
        { id: "memory-curator", name: "Memory Curator" },
      ],
    });

    expect(chart.memoryCuration).toEqual({
      policyPath: "policies/curation-policy.yaml",
      role: "memory-curator",
    });
  });

  it("allows org chart without memoryCuration (backward compatible)", () => {
    const chart = OrgChart.parse({
      schemaVersion: 1,
      agents: [
        { id: "main", name: "Demerzel" },
      ],
    });

    expect(chart.memoryCuration).toBeUndefined();
  });

  it("rejects memoryCuration with missing policyPath", () => {
    const result = OrgChart.safeParse({
      schemaVersion: 1,
      memoryCuration: {
        role: "memory-curator",
      },
      agents: [
        { id: "main", name: "Demerzel" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects memoryCuration with missing role", () => {
    const result = OrgChart.safeParse({
      schemaVersion: 1,
      memoryCuration: {
        policyPath: "policies/curation-policy.yaml",
      },
      agents: [
        { id: "main", name: "Demerzel" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects memoryCuration with empty strings", () => {
    const result = OrgChart.safeParse({
      schemaVersion: 1,
      memoryCuration: {
        policyPath: "",
        role: "",
      },
      agents: [
        { id: "main", name: "Demerzel" },
      ],
    });

    expect(result.success).toBe(false);
  });
});
