import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MigrationContext } from "../migrations.js";

// --- Migration 001: defaultWorkflow ---

describe("Migration 001: default-workflow-template", () => {
  let tmpDir: string;
  let aofRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-mig001-"));
    aofRoot = tmpDir;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("adds defaultWorkflow when workflowTemplates exist", async () => {
    const { migration001 } = await import(
      "../migrations/001-default-workflow-template.js"
    );

    // Create project with workflowTemplates
    const projectDir = join(aofRoot, "Projects", "my-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "project.yaml"),
      `# Project config
id: my-project
title: My Project
type: swe
owner:
  team: eng
  lead: alice
# Workflow templates below
workflowTemplates:
  standard-sdlc:
    name: standard-sdlc
    hops:
      - id: dev
        role: swe-backend
  fast-track:
    name: fast-track
    hops:
      - id: deploy
        role: ops
`,
    );

    const ctx: MigrationContext = { aofRoot, version: "1.3.0" };
    await migration001.up(ctx);

    const result = await readFile(
      join(projectDir, "project.yaml"),
      "utf-8",
    );
    expect(result).toContain("defaultWorkflow: standard-sdlc");
  });

  it("preserves YAML comments", async () => {
    const { migration001 } = await import(
      "../migrations/001-default-workflow-template.js"
    );

    const projectDir = join(aofRoot, "Projects", "commented-proj");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "project.yaml"),
      `# Top-level comment
id: commented-proj
title: Commented Project # inline comment
type: swe
owner:
  team: eng
  lead: alice
workflowTemplates:
  review-flow:
    name: review-flow
    hops:
      - id: review
        role: qa
`,
    );

    const ctx: MigrationContext = { aofRoot, version: "1.3.0" };
    await migration001.up(ctx);

    const result = await readFile(
      join(projectDir, "project.yaml"),
      "utf-8",
    );
    expect(result).toContain("# Top-level comment");
    expect(result).toContain("# inline comment");
    expect(result).toContain("defaultWorkflow: review-flow");
  });

  it("skips project without workflowTemplates", async () => {
    const { migration001 } = await import(
      "../migrations/001-default-workflow-template.js"
    );

    const projectDir = join(aofRoot, "Projects", "bare-project");
    await mkdir(projectDir, { recursive: true });
    const original = `id: bare-project
title: Bare Project
type: swe
owner:
  team: eng
  lead: alice
`;
    await writeFile(join(projectDir, "project.yaml"), original);

    const ctx: MigrationContext = { aofRoot, version: "1.3.0" };
    await migration001.up(ctx);

    const result = await readFile(
      join(projectDir, "project.yaml"),
      "utf-8",
    );
    expect(result).not.toContain("defaultWorkflow");
    // File should be unchanged
    expect(result).toBe(original);
  });

  it("skips project that already has defaultWorkflow (idempotent)", async () => {
    const { migration001 } = await import(
      "../migrations/001-default-workflow-template.js"
    );

    const projectDir = join(aofRoot, "Projects", "idempotent-proj");
    await mkdir(projectDir, { recursive: true });
    const original = `id: idempotent-proj
title: Already Set
type: swe
owner:
  team: eng
  lead: alice
defaultWorkflow: existing-flow
workflowTemplates:
  standard-sdlc:
    name: standard-sdlc
    hops:
      - id: dev
        role: swe-backend
`;
    await writeFile(join(projectDir, "project.yaml"), original);

    const ctx: MigrationContext = { aofRoot, version: "1.3.0" };
    await migration001.up(ctx);

    const result = await readFile(
      join(projectDir, "project.yaml"),
      "utf-8",
    );
    expect(result).toContain("defaultWorkflow: existing-flow");
    // Should not have changed the value
    expect(result).not.toContain("defaultWorkflow: standard-sdlc");
  });
});

// --- Migration 003: version-metadata ---

describe("Migration 003: version-metadata", () => {
  let tmpDir: string;
  let aofRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-mig003-"));
    aofRoot = tmpDir;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes installedAt for fresh install (no existing channel.json)", async () => {
    const { migration003 } = await import(
      "../migrations/003-version-metadata.js"
    );

    await mkdir(join(aofRoot, ".aof"), { recursive: true });

    const ctx: MigrationContext = { aofRoot, version: "1.3.0" };
    await migration003.up(ctx);

    const raw = await readFile(
      join(aofRoot, ".aof", "channel.json"),
      "utf-8",
    );
    const data = JSON.parse(raw);
    expect(data.version).toBe("1.3.0");
    expect(data.channel).toBe("stable");
    expect(data.installedAt).toBeDefined();
    expect(data.previousVersion).toBeUndefined();
    expect(data.upgradedAt).toBeUndefined();
  });

  it("writes previousVersion and upgradedAt for upgrade", async () => {
    const { migration003 } = await import(
      "../migrations/003-version-metadata.js"
    );

    await mkdir(join(aofRoot, ".aof"), { recursive: true });
    await writeFile(
      join(aofRoot, ".aof", "channel.json"),
      JSON.stringify({
        version: "1.2.0",
        channel: "stable",
        installedAt: "2025-01-01T00:00:00Z",
      }),
    );

    const ctx: MigrationContext = { aofRoot, version: "1.3.0" };
    await migration003.up(ctx);

    const raw = await readFile(
      join(aofRoot, ".aof", "channel.json"),
      "utf-8",
    );
    const data = JSON.parse(raw);
    expect(data.version).toBe("1.3.0");
    expect(data.previousVersion).toBe("1.2.0");
    expect(data.channel).toBe("stable");
    expect(data.upgradedAt).toBeDefined();
    expect(data.installedAt).toBeUndefined();
  });

  it("skips when existing channel.json has same version (idempotent)", async () => {
    const { migration003 } = await import(
      "../migrations/003-version-metadata.js"
    );

    await mkdir(join(aofRoot, ".aof"), { recursive: true });
    const original = JSON.stringify(
      {
        version: "1.3.0",
        channel: "stable",
        installedAt: "2025-06-01T00:00:00Z",
      },
      null,
      2,
    );
    await writeFile(join(aofRoot, ".aof", "channel.json"), original);

    const ctx: MigrationContext = { aofRoot, version: "1.3.0" };
    await migration003.up(ctx);

    const result = await readFile(
      join(aofRoot, ".aof", "channel.json"),
      "utf-8",
    );
    // Should be unchanged (same version = skip)
    expect(result).toBe(original);
  });
});
