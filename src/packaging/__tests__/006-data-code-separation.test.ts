import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MigrationContext } from "../migrations.js";
import { migration006 } from "../migrations/006-data-code-separation.js";

/**
 * Migration 006 computes paths from homedir() at call time, so we override
 * process.env.HOME per test to point at a temp directory. That's the only
 * global state the migration touches.
 */
describe("Migration 006: data-code-separation", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-mig006-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function exists(p: string): Promise<boolean> {
    try { await access(p); return true; } catch { return false; }
  }

  it("skips when legacy install dir does not exist", async () => {
    const newDataDir = join(tmpDir, ".aof", "data");
    const ctx: MigrationContext = { aofRoot: newDataDir, version: "1.13.0" };

    await migration006.up(ctx);

    expect(await exists(join(tmpDir, ".aof"))).toBe(false);
  });

  it("skips when data dir equals install dir (user override)", async () => {
    const installDir = join(tmpDir, ".aof");
    await mkdir(join(installDir, "tasks"), { recursive: true });
    await writeFile(join(installDir, "tasks", "t1.md"), "# task");

    const ctx: MigrationContext = { aofRoot: installDir, version: "1.13.0" };
    await migration006.up(ctx);

    // Data still where it was — not moved
    expect(await exists(join(installDir, "tasks", "t1.md"))).toBe(true);
    expect(await exists(join(installDir, ".migrated-to-data-subdir"))).toBe(false);
  });

  it("moves legacy mixed-layout data into the new data subdir", async () => {
    const installDir = join(tmpDir, ".aof");
    const newDataDir = join(installDir, "data");

    // Pre-v1.13 layout: data mixed with code at install root
    await mkdir(join(installDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(installDir, "events"), { recursive: true });
    await mkdir(join(installDir, "Projects", "demo"), { recursive: true });
    await mkdir(join(installDir, "org"), { recursive: true });
    await writeFile(join(installDir, "tasks", "ready", "t1.md"), "# task");
    await writeFile(join(installDir, "events", "2026-04-13.jsonl"), "{}");
    await writeFile(join(installDir, "Projects", "demo", "state.json"), "{}");
    await writeFile(join(installDir, "org", "org-chart.yaml"), "agents: []");
    await writeFile(join(installDir, "memory.db"), "");

    const ctx: MigrationContext = { aofRoot: newDataDir, version: "1.13.0" };
    await migration006.up(ctx);

    // Data in new location
    expect(await exists(join(newDataDir, "tasks", "ready", "t1.md"))).toBe(true);
    expect(await exists(join(newDataDir, "events", "2026-04-13.jsonl"))).toBe(true);
    expect(await exists(join(newDataDir, "Projects", "demo", "state.json"))).toBe(true);
    expect(await exists(join(newDataDir, "org", "org-chart.yaml"))).toBe(true);
    expect(await exists(join(newDataDir, "memory.db"))).toBe(true);

    // Legacy locations gone
    expect(await exists(join(installDir, "tasks"))).toBe(false);
    expect(await exists(join(installDir, "events"))).toBe(false);
    expect(await exists(join(installDir, "Projects"))).toBe(false);
    expect(await exists(join(installDir, "org"))).toBe(false);
    expect(await exists(join(installDir, "memory.db"))).toBe(false);

    // Breadcrumb written
    expect(await exists(join(installDir, ".migrated-to-data-subdir"))).toBe(true);
  });

  it("replaces empty scaffold at the destination with the legacy data", async () => {
    // Scenario: migration 004 (scaffold-repair) ran first and created empty
    // scaffold at ~/.aof/data/tasks/{ready,in-progress,...}. Migration 006
    // must treat that as non-conflicting and perform the move anyway.
    const installDir = join(tmpDir, ".aof");
    const newDataDir = join(installDir, "data");

    // Legacy: real user data at root
    await mkdir(join(installDir, "tasks", "ready"), { recursive: true });
    await writeFile(join(installDir, "tasks", "ready", "t1.md"), "# real task");

    // Pre-existing scaffold at new location — empty subdirs, no files
    await mkdir(join(newDataDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(newDataDir, "tasks", "in-progress"), { recursive: true });

    const ctx: MigrationContext = { aofRoot: newDataDir, version: "1.13.0" };
    await migration006.up(ctx);

    // User data won, scaffold got replaced
    const content = await readFile(join(newDataDir, "tasks", "ready", "t1.md"), "utf-8");
    expect(content).toBe("# real task");

    // No conflict stash created
    const stashes = await stat(join(installDir, "tasks")).catch(() => null);
    expect(stashes).toBeNull();
  });

  it("stashes legacy data when destination has real content", async () => {
    // Both sides have real files — migration must not merge blindly. Legacy
    // gets renamed to <name>.migrated-<ts> for manual reconciliation.
    const installDir = join(tmpDir, ".aof");
    const newDataDir = join(installDir, "data");

    await mkdir(join(installDir, "org"), { recursive: true });
    await writeFile(join(installDir, "org", "org-chart.yaml"), "legacy chart");

    await mkdir(join(newDataDir, "org"), { recursive: true });
    await writeFile(join(newDataDir, "org", "org-chart.yaml"), "scaffold chart");

    const ctx: MigrationContext = { aofRoot: newDataDir, version: "1.13.0" };
    await migration006.up(ctx);

    // New location kept its content
    const content = await readFile(join(newDataDir, "org", "org-chart.yaml"), "utf-8");
    expect(content).toBe("scaffold chart");

    // Legacy moved to stash — directory name ends in .migrated-<ts>
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(installDir);
    const stash = entries.find((e) => e.startsWith("org.migrated-"));
    expect(stash).toBeDefined();
    const stashChart = await readFile(join(installDir, stash!, "org-chart.yaml"), "utf-8");
    expect(stashChart).toBe("legacy chart");
  });

  it("is idempotent — second run is a no-op", async () => {
    const installDir = join(tmpDir, ".aof");
    const newDataDir = join(installDir, "data");

    await mkdir(join(installDir, "tasks"), { recursive: true });
    await writeFile(join(installDir, "tasks", "t1.md"), "# task");

    const ctx: MigrationContext = { aofRoot: newDataDir, version: "1.13.0" };
    await migration006.up(ctx);

    // Second run should skip (breadcrumb present)
    await migration006.up(ctx);

    expect(await exists(join(newDataDir, "tasks", "t1.md"))).toBe(true);
  });

  it("updates openclaw.json plugin dataDir to the new location", async () => {
    const installDir = join(tmpDir, ".aof");
    const newDataDir = join(installDir, "data");
    const openclawDir = join(tmpDir, ".openclaw");
    const configPath = join(openclawDir, "openclaw.json");

    await mkdir(openclawDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          entries: { aof: { enabled: true, config: { dataDir: "~/.aof" } } },
        },
      }),
    );

    // Need some data to trigger migration (it no-ops with no legacy data)
    await mkdir(join(installDir, "tasks"), { recursive: true });
    await writeFile(join(installDir, "tasks", "t1.md"), "# task");

    const ctx: MigrationContext = { aofRoot: newDataDir, version: "1.13.0" };
    await migration006.up(ctx);

    const updatedConfig = JSON.parse(await readFile(configPath, "utf-8"));
    expect(updatedConfig.plugins.entries.aof.config.dataDir).toBe(newDataDir);

    // Backup of old config exists
    const { readdir } = await import("node:fs/promises");
    const openclawFiles = await readdir(openclawDir);
    const backup = openclawFiles.find((f) => f.includes("pre-migration006.backup"));
    expect(backup).toBeDefined();
  });

  it("does not update openclaw.json when dataDir already points at the new location", async () => {
    const installDir = join(tmpDir, ".aof");
    const newDataDir = join(installDir, "data");
    const openclawDir = join(tmpDir, ".openclaw");
    const configPath = join(openclawDir, "openclaw.json");

    await mkdir(openclawDir, { recursive: true });
    const configContent = JSON.stringify({
      plugins: {
        entries: { aof: { enabled: true, config: { dataDir: "/some/custom/path" } } },
      },
    });
    await writeFile(configPath, configContent);

    await mkdir(join(installDir, "tasks"), { recursive: true });
    await writeFile(join(installDir, "tasks", "t1.md"), "# task");

    const ctx: MigrationContext = { aofRoot: newDataDir, version: "1.13.0" };
    await migration006.up(ctx);

    // Config unchanged
    const after = await readFile(configPath, "utf-8");
    expect(JSON.parse(after)).toEqual(JSON.parse(configContent));
  });
});
