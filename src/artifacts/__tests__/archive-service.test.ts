import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { ArtifactArchiveService, readManifest } from "../archive-service.js";
import { ARTIFACT_INDEX_FILENAME } from "../paths.js";

describe("ArtifactArchiveService", () => {
  let tmpDir: string;
  let archiveRoot: string;
  let trashRoot: string;
  const now = () => new Date("2026-04-26T03:00:00.000Z");

  beforeEach(async () => {
    tmpDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "aof-artifacts-test-")));
    archiveRoot = join(tmpDir, "cold-storage");
    trashRoot = join(tmpDir, "Trash");
    await mkdir(trashRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("archives, lists, and restores an artifact directory with manifest and index metadata", async () => {
    const sourceDir = await fixtureArtifact("report-output");
    const service = new ArtifactArchiveService({ now });

    const archived = await service.archive({
      sourceDir,
      project: "Demo Project",
      title: "Report Output",
      tags: ["report", "gold"],
      notes: "keep locally",
      archiveRoot,
    });

    expect(existsSync(sourceDir)).toBe(true);
    expect(existsSync(archived.manifest.archive_path)).toBe(true);
    expect(existsSync(archived.manifestPath)).toBe(true);
    expect(archived.manifest).toMatchObject({
      schema_version: 1,
      id: "20260426T030000Z-demo-project-report-output",
      project: "Demo Project",
      title: "Report Output",
      file_count: 2,
      original_bytes: 10,
      tags: ["report", "gold"],
      notes: "keep locally",
      destructive_prune_performed: false,
    });

    const manifestOnDisk = await readManifest(archived.manifestPath);
    expect(manifestOnDisk).toEqual(archived.manifest);

    const db = new Database(join(archiveRoot, ARTIFACT_INDEX_FILENAME));
    try {
      const row = db.prepare("SELECT * FROM artifact_archives WHERE id = ?").get(archived.manifest.id) as Record<string, unknown>;
      expect(row).toMatchObject({
        schema_version: 1,
        project: "Demo Project",
        title: "Report Output",
        manifest_path: archived.manifestPath,
        sha256: archived.manifest.sha256,
        file_count: 2,
        original_bytes: 10,
        tags_json: JSON.stringify(["report", "gold"]),
        notes: "keep locally",
        destructive_prune_performed: 0,
      });
    } finally {
      db.close();
    }

    const rows = await service.list({ archiveRoot, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: archived.manifest.id, title: "Report Output", tags: ["report", "gold"] });

    const restoreParent = join(tmpDir, "restore-here");
    const restored = await service.restore({ archiveId: archived.manifest.id, destParent: restoreParent, archiveRoot });
    expect(restored.restoredPath).toBe(join(restoreParent, basename(sourceDir)));
    await expect(readFile(join(restored.restoredPath, "nested", "b.txt"), "utf-8")).resolves.toBe("bravo");
    await expect(readFile(join(restored.restoredPath, "archive-restored.json"), "utf-8")).resolves.toContain(archived.manifest.id);
  });

  it("fails clearly for a missing source and creates no archive index", async () => {
    const service = new ArtifactArchiveService({ now });
    const missing = join(tmpDir, "missing-artifact");

    await expect(service.archive({ sourceDir: missing, archiveRoot })).rejects.toThrow(/source directory not found/i);

    expect(existsSync(join(archiveRoot, ARTIFACT_INDEX_FILENAME))).toBe(false);
  });

  it("returns an empty list when no index exists", async () => {
    const service = new ArtifactArchiveService({ now });

    await expect(service.list({ archiveRoot })).resolves.toEqual([]);
  });

  it("fails restore for unknown ids and missing archives without creating output", async () => {
    const sourceDir = await fixtureArtifact("unknown-check");
    const service = new ArtifactArchiveService({ now });
    const archived = await service.archive({ sourceDir, archiveRoot });
    const destParent = join(tmpDir, "restore-output");

    await expect(service.restore({ archiveId: "missing-id", destParent, archiveRoot })).rejects.toThrow(/unknown artifact archive id/i);
    expect(existsSync(destParent)).toBe(false);

    await rm(archived.manifest.archive_path);
    await expect(service.restore({ archiveId: archived.manifest.id, destParent, archiveRoot })).rejects.toThrow(/archive file not found/i);
    expect(existsSync(destParent)).toBe(false);
  });

  it("verifies hash before extraction and leaves destination absent on mismatch", async () => {
    const sourceDir = await fixtureArtifact("hash-check");
    const service = new ArtifactArchiveService({ now });
    const archived = await service.archive({ sourceDir, archiveRoot });
    await writeFile(archived.manifest.archive_path, "tampered", "utf-8");
    const destParent = join(tmpDir, "restore-output");

    await expect(service.restore({ archiveId: archived.manifest.id, destParent, archiveRoot })).rejects.toThrow(/hash mismatch/i);

    expect(existsSync(destParent)).toBe(false);
  });

  it("moves the source to Trash only after archive, manifest, and index succeed", async () => {
    const sourceDir = await fixtureArtifact("prune-me");
    const service = new ArtifactArchiveService({ now });

    const archived = await service.archive({
      sourceDir,
      archiveRoot,
      trashRoot,
      pruneOriginalToTrash: true,
    });

    expect(existsSync(sourceDir)).toBe(false);
    expect(archived.manifest.destructive_prune_performed).toBe(true);
    expect(archived.manifest.trash_path).toBe(join(trashRoot, "prune-me"));
    expect(existsSync(archived.manifest.trash_path!)).toBe(true);
    expect(existsSync(archived.manifest.archive_path)).toBe(true);

    const manifestOnDisk = await readManifest(archived.manifestPath);
    expect(manifestOnDisk.destructive_prune_performed).toBe(true);
    expect(manifestOnDisk.trash_path).toBe(join(trashRoot, "prune-me"));

    const db = new Database(join(archiveRoot, ARTIFACT_INDEX_FILENAME));
    try {
      const row = db.prepare("SELECT destructive_prune_performed, trash_path FROM artifact_archives WHERE id = ?")
        .get(archived.manifest.id) as { destructive_prune_performed: number; trash_path: string };
      expect(row.destructive_prune_performed).toBe(1);
      expect(row.trash_path).toBe(join(trashRoot, "prune-me"));
    } finally {
      db.close();
    }
  });

  async function fixtureArtifact(name: string): Promise<string> {
    const sourceDir = join(tmpDir, name);
    await mkdir(join(sourceDir, "nested"), { recursive: true });
    await writeFile(join(sourceDir, "a.txt"), "alpha", "utf-8");
    await writeFile(join(sourceDir, "nested", "b.txt"), "bravo", "utf-8");
    const a = await stat(join(sourceDir, "a.txt"));
    const b = await stat(join(sourceDir, "nested", "b.txt"));
    expect(a.size + b.size).toBe(10);
    return sourceDir;
  }
});
