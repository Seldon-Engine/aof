/**
 * Tests for the `aof smoke` post-install health check command.
 *
 * Validates each individual smoke check (version, schema, task store,
 * org chart, migrations, workflows) and the aggregated runner.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { runSmokeChecks } from "../smoke.js";

/** Minimal valid project manifest for testing. */
function validProjectYaml(overrides: Record<string, unknown> = {}): string {
  return stringifyYaml(
    {
      id: "test-project",
      title: "Test Project",
      status: "active",
      type: "swe",
      owner: { team: "test-team", lead: "test-lead" },
      participants: [],
      routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
      memory: {
        tiers: { bronze: "cold", silver: "warm", gold: "warm" },
        allowIndex: { warmPaths: ["Artifacts/Silver", "Artifacts/Gold"] },
        denyIndex: ["Cold", "Artifacts/Bronze", "State", "Tasks"],
      },
      links: { dashboards: [], docs: [] },
      workflowTemplates: {
        "code-review": {
          name: "code-review",
          hops: [
            { id: "implement", role: "swe-backend", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
            { id: "review", role: "swe-qa", dependsOn: ["implement"], joinType: "all", autoAdvance: true, canReject: false },
          ],
        },
      },
      defaultWorkflow: "code-review",
      ...overrides,
    },
    { lineWidth: 120 },
  );
}

/** Minimal valid org chart for testing. */
function validOrgChartYaml(): string {
  return stringifyYaml(
    {
      schemaVersion: 2,
      orgUnits: [],
      groups: [],
      memberships: [],
      relationships: [],
      teams: [],
      agents: [
        {
          id: "agent-1",
          name: "Agent One",
          capabilities: { tags: ["swe"], concurrency: 1 },
          comms: { preferred: "send", fallbacks: ["send", "cli"] },
          active: true,
        },
      ],
      routing: [],
      metadata: {},
    },
    { lineWidth: 120 },
  );
}

/** Scaffold a complete valid AOF data directory. */
async function scaffoldValidDir(root: string): Promise<void> {
  // package.json
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "aof", version: "1.3.0" }));

  // Project with manifest
  const projectDir = join(root, "Projects", "test-project");
  await mkdir(join(projectDir, "tasks", "backlog"), { recursive: true });
  await mkdir(join(projectDir, "tasks", "ready"), { recursive: true });
  await mkdir(join(projectDir, "tasks", "done"), { recursive: true });
  await writeFile(join(projectDir, "project.yaml"), validProjectYaml());

  // Org chart
  await mkdir(join(root, "org"), { recursive: true });
  await writeFile(join(root, "org", "org-chart.yaml"), validOrgChartYaml());

  // Migration history
  await mkdir(join(root, ".aof"), { recursive: true });
  await writeFile(
    join(root, ".aof", "migrations.json"),
    JSON.stringify({
      migrations: [
        { id: "001", version: "1.3.0", description: "Default workflow template", appliedAt: "2026-01-01T00:00:00Z" },
      ],
    }),
  );
}

describe("runSmokeChecks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-smoke-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("all checks pass on a valid data directory", async () => {
    await scaffoldValidDir(tmpDir);

    const result = await runSmokeChecks(tmpDir);

    expect(result.allPassed).toBe(true);
    for (const check of result.checks) {
      expect(check.pass, `Check '${check.name}' should pass`).toBe(true);
    }
    expect(result.checks.length).toBeGreaterThanOrEqual(6);
  });

  it("version check fails when package.json is missing", async () => {
    await scaffoldValidDir(tmpDir);
    await rm(join(tmpDir, "package.json"));

    const result = await runSmokeChecks(tmpDir);

    const versionCheck = result.checks.find((c) => c.name.toLowerCase().includes("version"));
    expect(versionCheck).toBeDefined();
    expect(versionCheck!.pass).toBe(false);
    expect(result.allPassed).toBe(false);
  });

  it("schema check fails when project.yaml has invalid schema", async () => {
    await scaffoldValidDir(tmpDir);
    // Write an invalid project.yaml (missing required fields)
    await writeFile(
      join(tmpDir, "Projects", "test-project", "project.yaml"),
      stringifyYaml({ id: "test-project" }),
    );

    const result = await runSmokeChecks(tmpDir);

    const schemaCheck = result.checks.find((c) => c.name.toLowerCase().includes("schema"));
    expect(schemaCheck).toBeDefined();
    expect(schemaCheck!.pass).toBe(false);
  });

  it("task store check fails when tasks directory is missing", async () => {
    await scaffoldValidDir(tmpDir);
    // Remove all task directories
    await rm(join(tmpDir, "Projects", "test-project", "tasks"), { recursive: true, force: true });

    const result = await runSmokeChecks(tmpDir);

    const taskCheck = result.checks.find((c) => c.name.toLowerCase().includes("task"));
    expect(taskCheck).toBeDefined();
    expect(taskCheck!.pass).toBe(false);
  });

  it("org chart check fails when org-chart.yaml is malformed", async () => {
    await scaffoldValidDir(tmpDir);
    // Write malformed org chart (missing required 'agents' field)
    await writeFile(
      join(tmpDir, "org", "org-chart.yaml"),
      stringifyYaml({ schemaVersion: 2 }),
    );

    const result = await runSmokeChecks(tmpDir);

    const orgCheck = result.checks.find((c) => c.name.toLowerCase().includes("org"));
    expect(orgCheck).toBeDefined();
    expect(orgCheck!.pass).toBe(false);
  });

  it("migration check reports correct applied migration count", async () => {
    await scaffoldValidDir(tmpDir);

    const result = await runSmokeChecks(tmpDir);

    const migrationCheck = result.checks.find((c) => c.name.toLowerCase().includes("migration"));
    expect(migrationCheck).toBeDefined();
    expect(migrationCheck!.pass).toBe(true);
    expect(migrationCheck!.detail).toContain("1");
  });

  it("workflow template check fails when defaultWorkflow references nonexistent template", async () => {
    await scaffoldValidDir(tmpDir);
    // Write project.yaml with defaultWorkflow pointing to nonexistent template
    await writeFile(
      join(tmpDir, "Projects", "test-project", "project.yaml"),
      validProjectYaml({ defaultWorkflow: "nonexistent-template" }),
    );

    const result = await runSmokeChecks(tmpDir);

    const workflowCheck = result.checks.find((c) => c.name.toLowerCase().includes("workflow"));
    expect(workflowCheck).toBeDefined();
    expect(workflowCheck!.pass).toBe(false);
  });

  it("overall result is pass only when all individual checks pass", async () => {
    await scaffoldValidDir(tmpDir);
    // Remove package.json to cause one failure
    await rm(join(tmpDir, "package.json"));

    const result = await runSmokeChecks(tmpDir);

    // At least one check should fail
    const failedChecks = result.checks.filter((c) => !c.pass);
    expect(failedChecks.length).toBeGreaterThan(0);
    expect(result.allPassed).toBe(false);

    // Other checks should still run (not short-circuit)
    expect(result.checks.length).toBeGreaterThanOrEqual(6);
  });

  it("handles completely empty directory gracefully", async () => {
    // tmpDir exists but is empty -- should not crash
    const result = await runSmokeChecks(tmpDir);

    expect(result.allPassed).toBe(false);
    // Should still have all check results (no crash/short-circuit)
    expect(result.checks.length).toBeGreaterThanOrEqual(6);
  });
});
