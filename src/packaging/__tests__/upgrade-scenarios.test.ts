/**
 * Upgrade scenario tests — exercises the actual migration runner
 * against four realistic install/upgrade paths.
 *
 * Each test uses static YAML fixtures (or wizard output) and runs
 * the real migration code to verify end-state correctness.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  readFile,
  cp,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import { runMigrations, getMigrationHistory } from "../migrations.js";
import { migration001 } from "../migrations/001-default-workflow-template.js";
import { migration002 } from "../migrations/002-gate-to-dag-batch.js";
import { migration003 } from "../migrations/003-version-metadata.js";
import { runWizard } from "../wizard.js";

/**
 * Returns all migrations in order (same pattern as setup.ts).
 */
function getAllMigrations() {
  return [migration001, migration002, migration003];
}

/**
 * Copy a fixture directory into a destination directory.
 */
async function copyFixture(fixtureName: string, dest: string): Promise<void> {
  const fixtureDir = join(import.meta.dirname, "__fixtures__", fixtureName);
  await cp(fixtureDir, dest, { recursive: true });
}

describe("Upgrade scenarios", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-upgrade-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("fresh install: wizard + migration003 creates channel.json and task dirs", async () => {
    // Fresh install: empty temp dir + runWizard + migration003
    await runWizard({
      installDir: tmpDir,
      template: "minimal",
      interactive: false,
      skipOpenClaw: true,
    });

    // Run migration003 directly (same as setup.ts does for fresh installs)
    await migration003.up({ aofRoot: tmpDir, version: "1.3.0" });

    // Verify: channel.json exists with version metadata
    const channelRaw = await readFile(
      join(tmpDir, ".aof", "channel.json"),
      "utf-8",
    );
    const channel = JSON.parse(channelRaw);
    expect(channel.version).toBe("1.3.0");
    expect(channel.channel).toBe("stable");
    expect(channel.installedAt).toBeDefined();

    // Verify: task status directories exist
    await access(join(tmpDir, "tasks", "backlog"));
    await access(join(tmpDir, "tasks", "ready"));
    await access(join(tmpDir, "tasks", "in-progress"));
    await access(join(tmpDir, "tasks", "done"));
  });

  it("pre-v1.2 upgrade: all 3 migrations apply to gate-based project", async () => {
    // Copy pre-v1.2-upgrade fixture (has gate-based task, no defaultWorkflow)
    await copyFixture("pre-v1.2-upgrade", tmpDir);

    const result = await runMigrations({
      aofRoot: tmpDir,
      migrations: getAllMigrations(),
      targetVersion: "1.3.0",
    });

    // All 3 migrations should apply
    expect(result.success).toBe(true);
    expect(result.applied).toHaveLength(3);

    // Migration 001: defaultWorkflow added to project.yaml
    const projectRaw = await readFile(
      join(tmpDir, "Projects", "demo", "project.yaml"),
      "utf-8",
    );
    const project = parseYaml(projectRaw) as Record<string, unknown>;
    expect(project.defaultWorkflow).toBe("standard-sdlc");

    // Migration 002: gate task converted to DAG workflow
    const taskRaw = await readFile(
      join(
        tmpDir,
        "Projects",
        "demo",
        "tasks",
        "backlog",
        "TASK-2026-01-01-001.md",
      ),
      "utf-8",
    );
    // Gate field should be cleared (migration002 converts gate -> workflow)
    expect(taskRaw).toContain("workflow:");
    expect(taskRaw).not.toMatch(/^gate:/m);

    // Migration 003: channel.json created with version metadata
    const channelRaw = await readFile(
      join(tmpDir, ".aof", "channel.json"),
      "utf-8",
    );
    const channel = JSON.parse(channelRaw);
    expect(channel.version).toBe("1.3.0");

    // Migration history records all 3
    const history = await getMigrationHistory(tmpDir);
    expect(history.migrations).toHaveLength(3);
  });

  it("v1.2 upgrade: only migration003 applies (001+002 already recorded)", async () => {
    // Copy v1.2-upgrade fixture (001+002 already in migrations.json)
    await copyFixture("v1.2-upgrade", tmpDir);

    const result = await runMigrations({
      aofRoot: tmpDir,
      migrations: getAllMigrations(),
      targetVersion: "1.3.0",
    });

    // Only migration003 should apply (others already in history)
    expect(result.success).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toBe("003-version-metadata");

    // channel.json should exist now
    const channelRaw = await readFile(
      join(tmpDir, ".aof", "channel.json"),
      "utf-8",
    );
    const channel = JSON.parse(channelRaw);
    expect(channel.version).toBe("1.3.0");

    // Migration history: 2 pre-existing + 1 new = 3 total
    const history = await getMigrationHistory(tmpDir);
    expect(history.migrations).toHaveLength(3);
  });

  it("DAG-default: defaultWorkflow preserved, migrations apply cleanly", async () => {
    // Copy dag-default fixture (already has defaultWorkflow configured)
    await copyFixture("dag-default", tmpDir);

    const result = await runMigrations({
      aofRoot: tmpDir,
      migrations: getAllMigrations(),
      targetVersion: "1.3.0",
    });

    expect(result.success).toBe(true);

    // defaultWorkflow should be preserved (not overwritten by migration001)
    const projectRaw = await readFile(
      join(tmpDir, "Projects", "demo", "project.yaml"),
      "utf-8",
    );
    const project = parseYaml(projectRaw) as Record<string, unknown>;
    expect(project.defaultWorkflow).toBe("standard-sdlc");

    // workflowTemplates should still be present
    expect(project.workflowTemplates).toBeDefined();
    const templates = project.workflowTemplates as Record<string, unknown>;
    expect(templates["standard-sdlc"]).toBeDefined();

    // channel.json should be created
    const channelRaw = await readFile(
      join(tmpDir, ".aof", "channel.json"),
      "utf-8",
    );
    const channel = JSON.parse(channelRaw);
    expect(channel.version).toBe("1.3.0");
  });
});
