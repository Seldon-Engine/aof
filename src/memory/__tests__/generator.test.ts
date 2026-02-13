import { describe, it, expect } from "vitest";
import { OrgChart } from "../../schemas/org-chart.js";
import { generateMemoryConfig, generateMemoryConfigWithProjects } from "../generator.js";
import type { ProjectRecord } from "../../projects/registry.js";

const makeChart = (overrides: Record<string, unknown>) => {
  const base = {
    schemaVersion: 1,
    agents: [
      { id: "main", name: "Main" },
      { id: "swe-backend", name: "SWE Backend" },
      { id: "swe-frontend", name: "SWE Frontend" },
      { id: "researcher", name: "Researcher" },
    ],
  };

  return OrgChart.parse({ ...base, ...overrides });
};

describe("generateMemoryConfig", () => {
  it("expands wildcard roles against agent IDs", () => {
    const chart = makeChart({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [
          {
            id: "runbooks",
            path: "Resources/OpenClaw/Runbooks",
            roles: ["swe-*"]
          }
        ],
        cold: [],
      },
    });

    const result = generateMemoryConfig(chart, { vaultRoot: "/vault" });

    expect(result.config.agents["swe-backend"].memorySearch.extraPaths).toContain(
      "/vault/Resources/OpenClaw/Runbooks"
    );
    expect(result.config.agents["swe-frontend"].memorySearch.extraPaths).toContain(
      "/vault/Resources/OpenClaw/Runbooks"
    );
    expect(result.config.agents["researcher"].memorySearch.extraPaths).not.toContain(
      "/vault/Resources/OpenClaw/Runbooks"
    );
  });

  it("expands 'all' roles to every agent", () => {
    const chart = makeChart({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [
          {
            id: "shared",
            path: "Resources/OpenClaw/Shared",
            roles: ["all"]
          }
        ],
        cold: [],
      },
    });

    const result = generateMemoryConfig(chart, { vaultRoot: "/vault" });

    for (const agentId of Object.keys(result.config.agents)) {
      expect(result.config.agents[agentId].memorySearch.extraPaths).toContain(
        "/vault/Resources/OpenClaw/Shared"
      );
    }
  });

  it("resolves relative pool paths against vault root", () => {
    const chart = makeChart({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    });

    const result = generateMemoryConfig(chart, { vaultRoot: "/vault" });

    expect(result.config.agents["main"].memorySearch.extraPaths).toEqual([
      "/vault/Resources/OpenClaw/_Core",
    ]);
  });

  it("returns empty config when memoryPools are missing", () => {
    const chart = makeChart({});

    const result = generateMemoryConfig(chart, { vaultRoot: "/vault" });

    expect(result.config.agents).toEqual({});
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("handles empty warm pools by emitting only hot paths", () => {
    const chart = makeChart({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: ["Logs"],
      },
    });

    const result = generateMemoryConfig(chart, { vaultRoot: "/vault" });

    expect(result.config.agents["swe-backend"].memorySearch.extraPaths).toEqual([
      "/vault/Resources/OpenClaw/_Core",
    ]);
  });

  it("dedupes paths when overlapping roles match", () => {
    const chart = makeChart({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [
          {
            id: "runbooks",
            path: "Resources/OpenClaw/Runbooks",
            roles: ["swe-*", "swe-backend"],
          }
        ],
        cold: [],
      },
    });

    const result = generateMemoryConfig(chart, { vaultRoot: "/vault" });

    const extraPaths = result.config.agents["swe-backend"].memorySearch.extraPaths;
    const runbookPaths = extraPaths.filter(path => path.endsWith("/Runbooks"));
    expect(runbookPaths).toHaveLength(1);
  });
});

const makeChartWithTeams = (overrides: Record<string, unknown>) => {
  const base = {
    schemaVersion: 1,
    agents: [
      { id: "main", name: "Main", team: "ops" },
      { id: "swe-backend", name: "SWE Backend", team: "engineering" },
      { id: "swe-frontend", name: "SWE Frontend", team: "engineering" },
      { id: "researcher", name: "Researcher", team: "research" },
    ],
  };

  return OrgChart.parse({ ...base, ...overrides });
};

const makeProject = (id: string, overrides: Record<string, unknown>): ProjectRecord => {
  const base = {
    id,
    title: `Project ${id}`,
    status: "active" as const,
    type: "swe" as const,
    owner: { team: "engineering", lead: "swe-backend" },
    participants: [],
    routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
    memory: {
      tiers: { bronze: "cold" as const, silver: "warm" as const, gold: "warm" as const },
      allowIndex: { warmPaths: ["Artifacts/Silver", "Artifacts/Gold"] },
      denyIndex: ["Cold", "Artifacts/Bronze", "State", "Tasks"],
    },
    links: { dashboards: [], docs: [] },
  };

  return {
    id,
    path: `/vault/Projects/${id}`,
    manifest: { ...base, ...overrides },
  };
};

describe("generateMemoryConfigWithProjects", () => {
  it("adds project warm paths for explicit participants", () => {
    const chart = makeChartWithTeams({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    });

    const projects: ProjectRecord[] = [
      makeProject("aof", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: ["researcher"],
      }),
    ];

    const result = generateMemoryConfigWithProjects(chart, projects, { vaultRoot: "/vault" });

    // researcher is participant
    const researcherPaths = result.config.agents["researcher"].memorySearch.extraPaths;
    expect(researcherPaths).toContain("/vault/Projects/aof/Artifacts/Silver");
    expect(researcherPaths).toContain("/vault/Projects/aof/Artifacts/Gold");

    // main is not enrolled
    expect(result.config.agents["main"]?.memorySearch.extraPaths).not.toContain(
      "/vault/Projects/aof/Artifacts/Silver"
    );
  });

  it("adds project warm paths for owner team members", () => {
    const chart = makeChartWithTeams({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    });

    const projects: ProjectRecord[] = [
      makeProject("aof", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: [],
      }),
    ];

    const result = generateMemoryConfigWithProjects(chart, projects, { vaultRoot: "/vault" });

    // swe-backend is in engineering team
    const backendPaths = result.config.agents["swe-backend"].memorySearch.extraPaths;
    expect(backendPaths).toContain("/vault/Projects/aof/Artifacts/Silver");
    expect(backendPaths).toContain("/vault/Projects/aof/Artifacts/Gold");

    // swe-frontend is also in engineering team
    const frontendPaths = result.config.agents["swe-frontend"].memorySearch.extraPaths;
    expect(frontendPaths).toContain("/vault/Projects/aof/Artifacts/Silver");
    expect(frontendPaths).toContain("/vault/Projects/aof/Artifacts/Gold");

    // researcher is NOT in engineering team
    expect(result.config.agents["researcher"]?.memorySearch.extraPaths || []).not.toContain(
      "/vault/Projects/aof/Artifacts/Silver"
    );
  });

  it("combines enrollment via participant and team", () => {
    const chart = makeChartWithTeams({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    });

    const projects: ProjectRecord[] = [
      makeProject("aof", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: ["researcher"],
      }),
    ];

    const result = generateMemoryConfigWithProjects(chart, projects, { vaultRoot: "/vault" });

    // Both swe-backend (team) and researcher (participant) should be enrolled
    expect(result.config.agents["swe-backend"].memorySearch.extraPaths).toContain(
      "/vault/Projects/aof/Artifacts/Silver"
    );
    expect(result.config.agents["researcher"].memorySearch.extraPaths).toContain(
      "/vault/Projects/aof/Artifacts/Silver"
    );
  });

  it("skips projects without manifests", () => {
    const chart = makeChartWithTeams({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    });

    const projects: ProjectRecord[] = [
      {
        id: "broken",
        path: "/vault/Projects/broken",
        error: "Missing project.yaml",
      },
    ];

    const result = generateMemoryConfigWithProjects(chart, projects, { vaultRoot: "/vault" });

    // Should not add any project paths
    for (const agentId of Object.keys(result.config.agents)) {
      const paths = result.config.agents[agentId].memorySearch.extraPaths;
      expect(paths.some((p) => p.includes("broken"))).toBe(false);
    }
  });

  it("dedupes org chart and project paths", () => {
    const chart = makeChartWithTeams({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [
          {
            id: "engineering",
            path: "Resources/OpenClaw/Engineering",
            roles: ["swe-*"],
          },
        ],
        cold: [],
      },
    });

    const projects: ProjectRecord[] = [
      makeProject("aof", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: [],
      }),
    ];

    const result = generateMemoryConfigWithProjects(chart, projects, { vaultRoot: "/vault" });

    const backendPaths = result.config.agents["swe-backend"].memorySearch.extraPaths;

    // Check no duplicates
    const uniquePaths = new Set(backendPaths);
    expect(uniquePaths.size).toBe(backendPaths.length);
  });

  it("respects custom warmPaths from project manifest", () => {
    const chart = makeChartWithTeams({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    });

    const projects: ProjectRecord[] = [
      makeProject("aof", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: [],
        memory: {
          tiers: { bronze: "cold" as const, silver: "warm" as const, gold: "warm" as const },
          allowIndex: { warmPaths: ["Docs", "Specs"] },
          denyIndex: [],
        },
      }),
    ];

    const result = generateMemoryConfigWithProjects(chart, projects, { vaultRoot: "/vault" });

    const backendPaths = result.config.agents["swe-backend"].memorySearch.extraPaths;
    expect(backendPaths).toContain("/vault/Projects/aof/Docs");
    expect(backendPaths).toContain("/vault/Projects/aof/Specs");
    expect(backendPaths).not.toContain("/vault/Projects/aof/Artifacts/Silver");
  });

  it("handles multiple projects for same agent", () => {
    const chart = makeChartWithTeams({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    });

    const projects: ProjectRecord[] = [
      makeProject("aof", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: [],
      }),
      makeProject("openclaw", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: [],
      }),
    ];

    const result = generateMemoryConfigWithProjects(chart, projects, { vaultRoot: "/vault" });

    const backendPaths = result.config.agents["swe-backend"].memorySearch.extraPaths;

    // Should have paths from both projects
    expect(backendPaths).toContain("/vault/Projects/aof/Artifacts/Silver");
    expect(backendPaths).toContain("/vault/Projects/aof/Artifacts/Gold");
    expect(backendPaths).toContain("/vault/Projects/openclaw/Artifacts/Silver");
    expect(backendPaths).toContain("/vault/Projects/openclaw/Artifacts/Gold");
  });

  it("sorts paths for deterministic output", () => {
    const chart = makeChartWithTeams({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    });

    const projects: ProjectRecord[] = [
      makeProject("zebra", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: [],
      }),
      makeProject("alpha", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: [],
      }),
    ];

    const result = generateMemoryConfigWithProjects(chart, projects, { vaultRoot: "/vault" });

    const backendPaths = result.config.agents["swe-backend"].memorySearch.extraPaths;

    // Check paths are sorted
    const sorted = [...backendPaths].sort();
    expect(backendPaths).toEqual(sorted);
  });

  it("warns when vaultRoot is missing", () => {
    const chart = makeChartWithTeams({
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    });

    const projects: ProjectRecord[] = [
      makeProject("aof", {
        owner: { team: "engineering", lead: "swe-backend" },
        participants: [],
      }),
    ];

    const result = generateMemoryConfigWithProjects(chart, projects, {});

    expect(result.warnings.some((w) => w.includes("vaultRoot"))).toBe(true);
  });
});
