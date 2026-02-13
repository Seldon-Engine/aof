/**
 * CLI Integration Tests — aof memory generate/audit commands
 *
 * Covers end-to-end generation + audit, linter integration, drift reporting,
 * and edge cases for Memory V2 configuration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { stringify } from "yaml";

describe("CLI: aof memory generate/audit", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "aof-memory-cli-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const baseChart = {
    schemaVersion: 1,
    agents: [
      { id: "main", name: "Main" },
      { id: "swe-backend", name: "SWE Backend" },
      { id: "swe-frontend", name: "SWE Frontend" },
    ],
  };

  const writeOrgChart = (chart: Record<string, unknown>, filename = "org-chart.yaml") => {
    const path = join(tempDir, filename);
    writeFileSync(path, stringify(chart));
    return path;
  };

  const writeConfig = (config: unknown, filename = "openclaw.json") => {
    const path = join(tempDir, filename);
    writeFileSync(path, JSON.stringify(config, null, 2));
    return path;
  };

  const runCli = (args: string[]) => {
    const result = spawnSync(
      "node",
      ["dist/cli/index.js", `--root=${tempDir}`, ...args],
      {
        encoding: "utf-8",
        env: { ...process.env, AOF_ROOT: tempDir },
      }
    );

    return {
      status: result.status ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  it("round-trips org chart → generate → audit with no drift", () => {
    const orgChart = {
      ...baseChart,
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
    };

    const orgPath = writeOrgChart(orgChart);
    const outputPath = join(tempDir, "generated", "memory-config.json");

    const generate = runCli([
      "memory",
      "generate",
      orgPath,
      "--out",
      outputPath,
      "--vault-root",
      "/vault",
    ]);

    expect(generate.status).toBe(0);
    expect(generate.stdout).toContain("✅ Memory config generated");

    const generatedConfig = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(generatedConfig.agents.main.memorySearch.extraPaths).toEqual([
      "/vault/Resources/OpenClaw/_Core",
    ]);
    // Paths are sorted alphabetically: Runbooks comes before _Core
    expect(generatedConfig.agents["swe-backend"].memorySearch.extraPaths).toEqual([
      "/vault/Resources/OpenClaw/Runbooks",
      "/vault/Resources/OpenClaw/_Core",
    ]);

    const audit = runCli([
      "memory",
      "audit",
      orgPath,
      "--config",
      outputPath,
      "--vault-root",
      "/vault",
    ]);

    expect(audit.status).toBe(0);
    expect(audit.stdout).toContain("No drift detected");
  });

  it("warns and audits when memoryPools are missing", () => {
    const orgPath = writeOrgChart(baseChart, "org-no-memory.yaml");
    const outputPath = join(tempDir, "generated", "memory-config.json");

    const generate = runCli(["memory", "generate", orgPath, "--out", outputPath]);

    expect(generate.status).toBe(0);
    expect(generate.stderr).toContain("No memoryPools defined in org chart");

    const generatedConfig = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(generatedConfig).toEqual({ agents: {} });

    const configPath = writeConfig({ agents: {} }, "openclaw.json");
    const audit = runCli(["memory", "audit", orgPath, "--config", configPath]);

    expect(audit.status).toBe(1);
    expect(audit.stdout).toContain("missing memorySearch.extraPaths configuration");
    expect(audit.stdout).toContain("main");
    expect(audit.stdout).toContain("swe-backend");
    expect(audit.stdout).toContain("swe-frontend");
  });

  it("fails lint before generation on invalid memoryPools", () => {
    const orgChart = {
      ...baseChart,
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [
          {
            id: "runbooks",
            path: "Resources/OpenClaw/Runbooks",
            roles: ["ghost"]
          }
        ],
        cold: [],
      },
    };

    const orgPath = writeOrgChart(orgChart, "org-invalid.yaml");
    const outputPath = join(tempDir, "generated", "memory-config.json");

    const generate = runCli([
      "memory",
      "generate",
      orgPath,
      "--out",
      outputPath,
      "--vault-root",
      "/vault",
    ]);

    expect(generate.status).toBe(1);
    expect(generate.stderr).toContain("valid-memory-pool-role");
    expect(existsSync(outputPath)).toBe(false);
  });

  it("reports drift for extra, missing, and removed agents", () => {
    const orgChart = {
      ...baseChart,
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
    };

    const orgPath = writeOrgChart(orgChart, "org-drift.yaml");
    const configPath = writeConfig(
      {
        agents: {
          main: {
            memorySearch: {
              extraPaths: [
                "/vault/Resources/OpenClaw/_Core",
                "/vault/Extra",
              ],
            },
          },
          "swe-backend": {
            memorySearch: {
              extraPaths: ["/vault/Resources/OpenClaw/_Core"],
            },
          },
          ghost: {
            memorySearch: {
              extraPaths: ["/vault/Resources/OpenClaw/_Core"],
            },
          },
        },
      },
      "openclaw-drift.json"
    );

    const audit = runCli([
      "memory",
      "audit",
      orgPath,
      "--config",
      configPath,
      "--vault-root",
      "/vault",
    ]);

    expect(audit.status).toBe(1);
    expect(audit.stdout).toContain("swe-frontend");
    expect(audit.stdout).toContain("missing memorySearch.extraPaths configuration");
    expect(audit.stdout).toContain("swe-backend");
    expect(audit.stdout).toContain("- /vault/Resources/OpenClaw/Runbooks");
    expect(audit.stdout).toContain("main");
    expect(audit.stdout).toContain("+ /vault/Extra");
    expect(audit.stdout).toContain("ghost");
    expect(audit.stdout).toContain("+ /vault/Resources/OpenClaw/_Core");
  });

  it("dedupes overlapping wildcard matches", () => {
    const orgChart = {
      ...baseChart,
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
    };

    const orgPath = writeOrgChart(orgChart, "org-dedupe.yaml");
    const outputPath = join(tempDir, "generated", "memory-config.json");

    const generate = runCli([
      "memory",
      "generate",
      orgPath,
      "--out",
      outputPath,
      "--vault-root",
      "/vault",
    ]);

    expect(generate.status).toBe(0);

    const generatedConfig = JSON.parse(readFileSync(outputPath, "utf-8"));
    const extraPaths = generatedConfig.agents["swe-backend"].memorySearch.extraPaths as string[];
    const runbookPaths = extraPaths.filter(path => path.endsWith("/Runbooks"));
    expect(runbookPaths).toHaveLength(1);
  });

  it("handles empty hot and warm pools", () => {
    const orgChart = {
      ...baseChart,
      memoryPools: {
        hot: { path: "/vault/Resources/OpenClaw/_Core", agents: [] },
        warm: [],
        cold: [],
      },
    };

    const orgPath = writeOrgChart(orgChart, "org-empty-pools.yaml");
    const outputPath = join(tempDir, "generated", "memory-config.json");

    const generate = runCli(["memory", "generate", orgPath, "--out", outputPath]);

    expect(generate.status).toBe(0);

    const generatedConfig = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(generatedConfig).toEqual({ agents: {} });
  });

  it("fails when resolving relative paths without a vault root", () => {
    const orgChart = {
      ...baseChart,
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    };

    const orgPath = writeOrgChart(orgChart, "org-no-vault.yaml");
    const outputPath = join(tempDir, "generated", "memory-config.json");

    const generate = runCli(["memory", "generate", orgPath, "--out", outputPath]);

    expect(generate.status).toBe(1);
    expect(generate.stderr).toContain("vaultRoot is required");
  });

  it("generates config with project enrollment paths", () => {
    const orgChart = {
      ...baseChart,
      teams: [{ id: "eng", name: "Engineering" }],
      agents: [
        { id: "main", name: "Main", team: "eng" },
        { id: "swe-backend", name: "SWE Backend", team: "eng" },
        { id: "swe-frontend", name: "SWE Frontend" },
      ],
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    };

    const orgPath = writeOrgChart(orgChart);
    const outputPath = join(tempDir, "generated", "memory-config.json");

    // Create vault structure with project
    const vaultRoot = join(tempDir, "vault");
    const projectPath = join(vaultRoot, "Projects", "test-project");
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(join(projectPath, "Docs"), { recursive: true });
    mkdirSync(join(projectPath, "Artifacts"), { recursive: true });

    const projectManifest = {
      id: "test-project",
      title: "Test Project",
      status: "active",
      type: "swe",
      owner: { team: "eng", lead: "main" },
      participants: ["swe-backend"],
      routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
      memory: {
        tiers: { bronze: "cold", silver: "warm", gold: "warm" },
        allowIndex: { warmPaths: ["Docs", "Artifacts"] },
        denyIndex: ["Cold", "State", "Tasks"],
      },
      links: { dashboards: [], docs: [] },
    };

    writeFileSync(join(projectPath, "project.yaml"), stringify(projectManifest));

    const generate = runCli([
      "memory",
      "generate",
      orgPath,
      "--out",
      outputPath,
      "--vault-root",
      vaultRoot,
    ]);

    expect(generate.status).toBe(0);
    expect(generate.stdout).toContain("✅ Memory config generated");
    expect(generate.stdout).toContain("Projects enrolled: 2"); // test-project + _inbox

    const generatedConfig = JSON.parse(readFileSync(outputPath, "utf-8"));

    // swe-backend is enrolled (explicit participant)
    expect(generatedConfig.agents["swe-backend"].memorySearch.extraPaths).toContain(
      join(vaultRoot, "Projects", "test-project", "Docs")
    );
    expect(generatedConfig.agents["swe-backend"].memorySearch.extraPaths).toContain(
      join(vaultRoot, "Projects", "test-project", "Artifacts")
    );

    // main is enrolled (team match)
    expect(generatedConfig.agents.main.memorySearch.extraPaths).toContain(
      join(vaultRoot, "Projects", "test-project", "Docs")
    );

    // swe-frontend is not enrolled (different team, not participant)
    const frontendPaths = generatedConfig.agents["swe-frontend"]?.memorySearch?.extraPaths ?? [];
    expect(frontendPaths).not.toContain(join(vaultRoot, "Projects", "test-project", "Docs"));
  });

  it("writes YAML artifact to vault Resources directory", () => {
    const orgChart = {
      ...baseChart,
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [
          {
            id: "runbooks",
            path: "Resources/OpenClaw/Runbooks",
            roles: ["swe-*"],
          },
        ],
        cold: [],
      },
    };

    const orgPath = writeOrgChart(orgChart);
    const outputPath = join(tempDir, "generated", "memory-config.json");
    const vaultRoot = join(tempDir, "vault");

    const generate = runCli([
      "memory",
      "generate",
      orgPath,
      "--out",
      outputPath,
      "--vault-root",
      vaultRoot,
    ]);

    expect(generate.status).toBe(0);
    expect(generate.stdout).toContain("✅ Memory artifact written");

    const artifactPath = join(
      vaultRoot,
      "Resources/OpenClaw/Ops/Config/recommended-memory-paths.yaml"
    );

    expect(existsSync(artifactPath)).toBe(true);

    const artifactContent = readFileSync(artifactPath, "utf-8");
    expect(artifactContent).toContain("agents:");
    expect(artifactContent).toContain("main:");
    expect(artifactContent).toContain("swe-backend:");
    expect(artifactContent).toContain("memorySearch:");
    expect(artifactContent).toContain("extraPaths:");
  });

  it("audit detects wildcard paths in config", () => {
    const orgChart = {
      ...baseChart,
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    };

    const orgPath = writeOrgChart(orgChart);
    const configPath = writeConfig(
      {
        agents: {
          main: {
            memorySearch: {
              extraPaths: [
                "/vault/Resources/OpenClaw/_Core",
                "/vault/Projects/**",
              ],
            },
          },
        },
      },
      "openclaw-wildcard.json"
    );

    const audit = runCli([
      "memory",
      "audit",
      orgPath,
      "--config",
      configPath,
      "--vault-root",
      "/vault",
    ]);

    expect(audit.status).toBe(1);
    expect(audit.stdout).toContain("main");
    expect(audit.stdout).toContain("⚠ wildcard detected: /vault/Projects/**");
    expect(audit.stdout).toContain("Wildcard issues: 1");
  });

  it("audit uses project enrollment when comparing configs", () => {
    const orgChart = {
      ...baseChart,
      teams: [{ id: "eng", name: "Engineering" }],
      agents: [
        { id: "main", name: "Main", team: "eng" },
        { id: "swe-backend", name: "SWE Backend", team: "eng" },
      ],
      memoryPools: {
        hot: { path: "Resources/OpenClaw/_Core" },
        warm: [],
        cold: [],
      },
    };

    const orgPath = writeOrgChart(orgChart);

    // Create vault structure with project
    const vaultRoot = join(tempDir, "vault");
    const projectPath = join(vaultRoot, "Projects", "test-project");
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(join(projectPath, "Docs"), { recursive: true });

    const projectManifest = {
      id: "test-project",
      title: "Test Project",
      status: "active",
      type: "swe",
      owner: { team: "eng", lead: "main" },
      participants: ["swe-backend"],
      routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
      memory: {
        tiers: { bronze: "cold", silver: "warm", gold: "warm" },
        allowIndex: { warmPaths: ["Docs"] },
        denyIndex: ["Cold", "State", "Tasks"],
      },
      links: { dashboards: [], docs: [] },
    };

    writeFileSync(join(projectPath, "project.yaml"), stringify(projectManifest));

    // Config missing project paths
    const configPath = writeConfig(
      {
        agents: {
          main: {
            memorySearch: {
              extraPaths: [join(vaultRoot, "Resources/OpenClaw/_Core")],
            },
          },
          "swe-backend": {
            memorySearch: {
              extraPaths: [join(vaultRoot, "Resources/OpenClaw/_Core")],
            },
          },
        },
      },
      "openclaw-missing-project.json"
    );

    const audit = runCli([
      "memory",
      "audit",
      orgPath,
      "--config",
      configPath,
      "--vault-root",
      vaultRoot,
    ]);

    expect(audit.status).toBe(1);
    expect(audit.stdout).toContain("main");
    expect(audit.stdout).toContain(`- ${join(vaultRoot, "Projects", "test-project", "Docs")}`);
    expect(audit.stdout).toContain("swe-backend");
  });
});
