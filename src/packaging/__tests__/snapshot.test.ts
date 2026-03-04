import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSnapshot, restoreSnapshot, pruneSnapshots } from "../snapshot.js";

describe("Snapshot Module", () => {
  let tmpDir: string;
  let aofRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-snapshot-test-"));
    aofRoot = join(tmpDir, "aof");
    await mkdir(aofRoot, { recursive: true });
    await mkdir(join(aofRoot, ".aof"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("createSnapshot()", () => {
    it("creates a snapshot directory under .aof/snapshots/", async () => {
      // Create some test data
      await mkdir(join(aofRoot, "tasks"), { recursive: true });
      await writeFile(join(aofRoot, "tasks", "task1.md"), "# Task 1");
      await writeFile(join(aofRoot, "config.yaml"), "schemaVersion: 1");

      const snapshotPath = await createSnapshot(aofRoot);

      // Verify snapshot was created
      expect(snapshotPath).toContain(".aof/snapshots/snapshot-");
      const content = await readFile(join(snapshotPath, "tasks", "task1.md"), "utf-8");
      expect(content).toBe("# Task 1");
      const configContent = await readFile(join(snapshotPath, "config.yaml"), "utf-8");
      expect(configContent).toBe("schemaVersion: 1");
    });

    it("creates a valid snapshot on empty data dir", async () => {
      const snapshotPath = await createSnapshot(aofRoot);

      expect(snapshotPath).toContain(".aof/snapshots/snapshot-");
      // Snapshot should exist as a directory
      const entries = await readdir(snapshotPath);
      // Should contain .aof (without snapshots/)
      expect(entries).toContain(".aof");
    });

    it("excludes .aof/snapshots/ from the snapshot to prevent recursive nesting", async () => {
      // Create a pre-existing snapshot
      const existingSnapshotDir = join(aofRoot, ".aof", "snapshots", "snapshot-old");
      await mkdir(existingSnapshotDir, { recursive: true });
      await writeFile(join(existingSnapshotDir, "marker.txt"), "old snapshot");

      // Also create a non-snapshot .aof entry
      await writeFile(join(aofRoot, ".aof", "migrations.json"), '{"migrations":[]}');

      const snapshotPath = await createSnapshot(aofRoot);

      // Verify .aof was copied
      const aofEntries = await readdir(join(snapshotPath, ".aof"));
      expect(aofEntries).toContain("migrations.json");
      // Verify snapshots/ was NOT copied
      expect(aofEntries).not.toContain("snapshots");
    });

    it("copies nested directory structures correctly", async () => {
      await mkdir(join(aofRoot, "Projects", "my-project", "tasks", "backlog"), { recursive: true });
      await writeFile(join(aofRoot, "Projects", "my-project", "project.yaml"), "id: my-project");
      await writeFile(join(aofRoot, "Projects", "my-project", "tasks", "backlog", "TASK-001.md"), "task content");

      const snapshotPath = await createSnapshot(aofRoot);

      const projectYaml = await readFile(join(snapshotPath, "Projects", "my-project", "project.yaml"), "utf-8");
      expect(projectYaml).toBe("id: my-project");
      const taskContent = await readFile(join(snapshotPath, "Projects", "my-project", "tasks", "backlog", "TASK-001.md"), "utf-8");
      expect(taskContent).toBe("task content");
    });
  });

  describe("restoreSnapshot()", () => {
    it("replaces current data with snapshot data", async () => {
      // Create initial data
      await mkdir(join(aofRoot, "tasks"), { recursive: true });
      await writeFile(join(aofRoot, "tasks", "task1.md"), "# Original");
      await writeFile(join(aofRoot, "config.yaml"), "original: true");

      // Take snapshot
      const snapshotPath = await createSnapshot(aofRoot);

      // Modify data (simulating a failed migration)
      await writeFile(join(aofRoot, "tasks", "task1.md"), "# Corrupted");
      await writeFile(join(aofRoot, "config.yaml"), "corrupted: true");
      await mkdir(join(aofRoot, "new-dir"), { recursive: true });
      await writeFile(join(aofRoot, "new-dir", "bad.txt"), "bad data");

      // Restore from snapshot
      await restoreSnapshot(aofRoot, snapshotPath);

      // Verify original data is back
      const task = await readFile(join(aofRoot, "tasks", "task1.md"), "utf-8");
      expect(task).toBe("# Original");
      const config = await readFile(join(aofRoot, "config.yaml"), "utf-8");
      expect(config).toBe("original: true");

      // Verify new-dir was removed
      await expect(access(join(aofRoot, "new-dir"))).rejects.toThrow();
    });

    it("preserves .aof/snapshots/ during restore", async () => {
      await writeFile(join(aofRoot, "data.txt"), "original");

      const snapshotPath = await createSnapshot(aofRoot);
      await writeFile(join(aofRoot, "data.txt"), "corrupted");

      // Create a second snapshot after modification
      const snapshot2Path = await createSnapshot(aofRoot);

      // Restore first snapshot — snapshots dir should survive
      await restoreSnapshot(aofRoot, snapshotPath);

      const data = await readFile(join(aofRoot, "data.txt"), "utf-8");
      expect(data).toBe("original");

      // Both snapshots should still exist
      const snapshots = await readdir(join(aofRoot, ".aof", "snapshots"));
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("pruneSnapshots()", () => {
    it("removes oldest snapshots when more than keep exist", async () => {
      const snapshotsDir = join(aofRoot, ".aof", "snapshots");
      await mkdir(snapshotsDir, { recursive: true });

      // Create 4 snapshots with distinct names (sorted by name = sorted by time)
      await mkdir(join(snapshotsDir, "snapshot-1000"));
      await mkdir(join(snapshotsDir, "snapshot-2000"));
      await mkdir(join(snapshotsDir, "snapshot-3000"));
      await mkdir(join(snapshotsDir, "snapshot-4000"));

      await pruneSnapshots(aofRoot, 2);

      const remaining = await readdir(snapshotsDir);
      expect(remaining.length).toBe(2);
      expect(remaining.sort()).toEqual(["snapshot-3000", "snapshot-4000"]);
    });

    it("does nothing when snapshots count is within limit", async () => {
      const snapshotsDir = join(aofRoot, ".aof", "snapshots");
      await mkdir(snapshotsDir, { recursive: true });

      await mkdir(join(snapshotsDir, "snapshot-1000"));
      await mkdir(join(snapshotsDir, "snapshot-2000"));

      await pruneSnapshots(aofRoot, 2);

      const remaining = await readdir(snapshotsDir);
      expect(remaining.length).toBe(2);
    });

    it("defaults to keeping 2 snapshots", async () => {
      const snapshotsDir = join(aofRoot, ".aof", "snapshots");
      await mkdir(snapshotsDir, { recursive: true });

      await mkdir(join(snapshotsDir, "snapshot-1000"));
      await mkdir(join(snapshotsDir, "snapshot-2000"));
      await mkdir(join(snapshotsDir, "snapshot-3000"));

      await pruneSnapshots(aofRoot);

      const remaining = await readdir(snapshotsDir);
      expect(remaining.length).toBe(2);
      expect(remaining.sort()).toEqual(["snapshot-2000", "snapshot-3000"]);
    });

    it("handles missing snapshots directory gracefully", async () => {
      // Should not throw
      await expect(pruneSnapshots(aofRoot, 2)).resolves.toBeUndefined();
    });
  });
});
