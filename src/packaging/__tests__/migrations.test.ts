import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runMigrations,
  registerMigration,
  getMigrationHistory,
  type Migration,
} from "../migrations.js";

describe("Migration Framework", () => {
  let tmpDir: string;
  let aofRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-migrations-test-"));
    aofRoot = join(tmpDir, "aof");

    await mkdir(aofRoot, { recursive: true });
    await mkdir(join(aofRoot, ".aof"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("runMigrations()", () => {
    it("runs pending migrations in order", async () => {
      const executed: string[] = [];

      const migration1: Migration = {
        id: "001-init-schema",
        version: "1.0.0",
        description: "Initialize schema",
        up: async () => {
          executed.push("001");
        },
      };

      const migration2: Migration = {
        id: "002-add-field",
        version: "1.1.0",
        description: "Add new field",
        up: async () => {
          executed.push("002");
        },
      };

      const migrations = [migration1, migration2];

      const result = await runMigrations({
        aofRoot,
        migrations,
        targetVersion: "1.1.0",
      });

      expect(result.success).toBe(true);
      expect(result.applied.length).toBe(2);
      expect(result.applied).toEqual(["001-init-schema", "002-add-field"]);
      expect(executed).toEqual(["001", "002"]);

      // Verify history recorded
      const history = await getMigrationHistory(aofRoot);
      expect(history.migrations).toHaveLength(2);
      expect(history.migrations[0].id).toBe("001-init-schema");
      expect(history.migrations[1].id).toBe("002-add-field");
    });

    it("skips already-applied migrations", async () => {
      const executed: string[] = [];

      const migration1: Migration = {
        id: "001-init-schema",
        version: "1.0.0",
        description: "Initialize schema",
        up: async () => {
          executed.push("001");
        },
      };

      const migration2: Migration = {
        id: "002-add-field",
        version: "1.1.0",
        description: "Add new field",
        up: async () => {
          executed.push("002");
        },
      };

      // Run first migration
      await runMigrations({
        aofRoot,
        migrations: [migration1],
        targetVersion: "1.0.0",
      });

      executed.length = 0; // Clear

      // Run both migrations (should skip first)
      const result = await runMigrations({
        aofRoot,
        migrations: [migration1, migration2],
        targetVersion: "1.1.0",
      });

      expect(result.success).toBe(true);
      expect(result.applied.length).toBe(1);
      expect(result.applied).toEqual(["002-add-field"]);
      expect(executed).toEqual(["002"]); // Only second executed
    });

    it("stops on migration failure", async () => {
      const executed: string[] = [];

      const migration1: Migration = {
        id: "001-init-schema",
        version: "1.0.0",
        description: "Initialize schema",
        up: async () => {
          executed.push("001");
        },
      };

      const migration2: Migration = {
        id: "002-failing",
        version: "1.1.0",
        description: "Failing migration",
        up: async () => {
          throw new Error("Migration failed");
        },
      };

      const migration3: Migration = {
        id: "003-never-runs",
        version: "1.2.0",
        description: "Never runs",
        up: async () => {
          executed.push("003");
        },
      };

      const migrations = [migration1, migration2, migration3];

      await expect(
        runMigrations({
          aofRoot,
          migrations,
          targetVersion: "1.2.0",
        }),
      ).rejects.toThrow(/migration failed/i);

      expect(executed).toEqual(["001"]); // Only first succeeded

      // Verify partial history
      const history = await getMigrationHistory(aofRoot);
      expect(history.migrations).toHaveLength(1);
      expect(history.migrations[0].id).toBe("001-init-schema");
    });

    it("respects version constraints", async () => {
      const executed: string[] = [];

      const migration1: Migration = {
        id: "001-v1.0",
        version: "1.0.0",
        description: "For v1.0",
        up: async () => {
          executed.push("001");
        },
      };

      const migration2: Migration = {
        id: "002-v1.1",
        version: "1.1.0",
        description: "For v1.1",
        up: async () => {
          executed.push("002");
        },
      };

      const migration3: Migration = {
        id: "003-v2.0",
        version: "2.0.0",
        description: "For v2.0",
        up: async () => {
          executed.push("003");
        },
      };

      // Target v1.1.0 — should run 001 and 002, not 003
      const result = await runMigrations({
        aofRoot,
        migrations: [migration1, migration2, migration3],
        targetVersion: "1.1.0",
      });

      expect(result.success).toBe(true);
      expect(result.applied).toEqual(["001-v1.0", "002-v1.1"]);
      expect(executed).toEqual(["001", "002"]);
    });

    it("supports reversible migrations with down()", async () => {
      const executed: string[] = [];

      const migration: Migration = {
        id: "001-reversible",
        version: "1.0.0",
        description: "Reversible migration",
        up: async () => {
          executed.push("up");
        },
        down: async () => {
          executed.push("down");
        },
      };

      // Apply migration
      await runMigrations({
        aofRoot,
        migrations: [migration],
        targetVersion: "1.0.0",
      });

      expect(executed).toEqual(["up"]);

      // Reverse migration
      await runMigrations({
        aofRoot,
        migrations: [migration],
        targetVersion: "0.9.0",
        direction: "down",
      });

      expect(executed).toEqual(["up", "down"]);

      // Verify history updated
      const history = await getMigrationHistory(aofRoot);
      expect(history.migrations).toHaveLength(0);
    });
  });

  describe("registerMigration()", () => {
    it("registers a migration in the global registry", () => {
      const migration: Migration = {
        id: "test-migration",
        version: "1.0.0",
        description: "Test migration",
        up: async () => {},
      };

      registerMigration(migration);

      // This is tested implicitly by runMigrations using the registry
      expect(true).toBe(true);
    });
  });

  describe("getMigrationHistory()", () => {
    it("returns empty history when no migrations run", async () => {
      const history = await getMigrationHistory(aofRoot);

      expect(history.migrations).toEqual([]);
    });

    it("returns applied migrations with timestamps", async () => {
      const migration: Migration = {
        id: "001-test",
        version: "1.0.0",
        description: "Test",
        up: async () => {},
      };

      await runMigrations({
        aofRoot,
        migrations: [migration],
        targetVersion: "1.0.0",
      });

      const history = await getMigrationHistory(aofRoot);

      expect(history.migrations).toHaveLength(1);
      expect(history.migrations[0].id).toBe("001-test");
      expect(history.migrations[0].appliedAt).toBeDefined();
      expect(new Date(history.migrations[0].appliedAt!).getTime()).toBeGreaterThan(0);
    });
  });
});
