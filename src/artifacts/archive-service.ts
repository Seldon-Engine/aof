import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ArtifactArchiveStore } from "./archive-store.js";
import {
  archiveArtifactOptionsSchema,
  artifactArchiveManifestSchema,
  listArtifactOptionsSchema,
  restoreArtifactOptionsSchema,
  type ArchiveArtifactOptions,
  type ArtifactArchiveManifest,
  type ArtifactArchiveRecord,
  type ListArtifactOptions,
  type RestoreArtifactOptions,
} from "./schema.js";
import {
  archiveManifestPath,
  archivePayloadPath,
  buildArchiveId,
  nextTrashTarget,
  resolveArchiveRoot,
  resolveIndexPath,
} from "./paths.js";
import { createTarGz, extractTarGz, sha256File } from "./tar.js";

export type ArchiveArtifactResult = {
  manifest: ArtifactArchiveManifest;
  manifestPath: string;
};

export type RestoreArtifactResult = {
  archiveId: string;
  restoredPath: string;
  receiptPath: string;
};

export type ArtifactArchiveServiceOptions = {
  now?: () => Date;
};

export class ArtifactArchiveService {
  private readonly now: () => Date;

  constructor(options: ArtifactArchiveServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async archive(options: ArchiveArtifactOptions): Promise<ArchiveArtifactResult> {
    const parsed = archiveArtifactOptionsSchema.parse(options);
    const sourceDir = resolve(parsed.sourceDir);
    await assertDirectory(sourceDir);

    const archiveRoot = resolveArchiveRoot(parsed.archiveRoot);
    const dbPath = resolveIndexPath(archiveRoot, parsed.dbPath);
    const store = await ArtifactArchiveStore.open(dbPath);

    try {
      const createdAtDate = this.now();
      const stats = await collectDirectoryStats(sourceDir);
      const archiveId = await this.reserveArchiveId(store, archiveRoot, parsed.project, sourceDir, createdAtDate);
      const archivePath = archivePayloadPath(archiveRoot, parsed.project, archiveId);
      const manifestPath = archiveManifestPath(archiveRoot, parsed.project, archiveId);
      const createdAt = createdAtDate.toISOString();

      await createTarGz(sourceDir, archivePath);
      const [sha256, archiveStat] = await Promise.all([sha256File(archivePath), stat(archivePath)]);
      let manifest = artifactArchiveManifestSchema.parse({
        schema_version: 1,
        id: archiveId,
        project: parsed.project,
        title: parsed.title ?? basename(sourceDir),
        source_path: sourceDir,
        archive_path: archivePath,
        sha256,
        file_count: stats.fileCount,
        original_bytes: stats.totalBytes,
        archive_bytes: archiveStat.size,
        created_at: createdAt,
        tags: parsed.tags,
        notes: parsed.notes,
        destructive_prune_performed: false,
      });

      await writeManifest(manifestPath, manifest);
      store.insert({
        id: manifest.id,
        schema_version: 1,
        project: manifest.project,
        title: manifest.title,
        source_path: manifest.source_path,
        archive_path: manifest.archive_path,
        manifest_path: manifestPath,
        sha256: manifest.sha256,
        file_count: manifest.file_count,
        original_bytes: manifest.original_bytes,
        archive_bytes: manifest.archive_bytes,
        created_at: manifest.created_at,
        tags_json: JSON.stringify(manifest.tags),
        notes: manifest.notes ?? null,
        destructive_prune_performed: 0,
        trash_path: null,
      });

      if (parsed.pruneOriginalToTrash) {
        const trashPath = await moveSourceToTrash(sourceDir, parsed.trashRoot);
        manifest = { ...manifest, destructive_prune_performed: true, trash_path: trashPath };
        await writeManifest(manifestPath, manifest);
        store.markPruned(manifest.id, trashPath);
      }

      return { manifest, manifestPath };
    } finally {
      store.close();
    }
  }

  async list(options: ListArtifactOptions = {}): Promise<ArtifactArchiveRecord[]> {
    const parsed = listArtifactOptionsSchema.parse(options);
    const archiveRoot = resolveArchiveRoot(parsed.archiveRoot);
    const dbPath = resolveIndexPath(archiveRoot, parsed.dbPath);
    const store = ArtifactArchiveStore.openExisting(dbPath);
    if (store === undefined) return [];

    try {
      return store.list(parsed.limit);
    } finally {
      store.close();
    }
  }

  async restore(options: RestoreArtifactOptions): Promise<RestoreArtifactResult> {
    const parsed = restoreArtifactOptionsSchema.parse(options);
    const archiveRoot = resolveArchiveRoot(parsed.archiveRoot);
    const dbPath = resolveIndexPath(archiveRoot, parsed.dbPath);
    const store = ArtifactArchiveStore.openExisting(dbPath);
    if (store === undefined) throw new Error(`Artifact archive index not found: ${dbPath}`);

    try {
      const record = store.get(parsed.archiveId);
      if (record === undefined) throw new Error(`Unknown artifact archive id: ${parsed.archiveId}`);
      await access(record.archive_path, constants.R_OK).catch(() => {
        throw new Error(`Artifact archive file not found: ${record.archive_path}`);
      });

      const actualHash = await sha256File(record.archive_path);
      if (actualHash !== record.sha256) {
        throw new Error(`Artifact archive hash mismatch for ${record.id}: expected ${record.sha256}, got ${actualHash}`);
      }

      const destParent = resolve(parsed.destParent);
      await extractTarGz(record.archive_path, destParent);
      const restoredPath = join(destParent, basename(record.source_path));
      const receiptPath = join(restoredPath, "archive-restored.json");
      await writeFile(
        receiptPath,
        `${JSON.stringify({
          archive_id: record.id,
          restored_at: this.now().toISOString(),
          archive_path: record.archive_path,
        }, null, 2)}\n`,
        "utf-8",
      );
      return { archiveId: record.id, restoredPath, receiptPath };
    } finally {
      store.close();
    }
  }

  private async reserveArchiveId(
    store: ArtifactArchiveStore,
    archiveRoot: string,
    project: string,
    sourceDir: string,
    createdAt: Date,
  ): Promise<string> {
    const baseId = buildArchiveId(createdAt, project, sourceDir);
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const candidate = attempt === 1 ? baseId : `${baseId}-${attempt}`;
      if (store.has(candidate)) continue;
      if (await pathExists(archivePayloadPath(archiveRoot, project, candidate))) continue;
      if (await pathExists(archiveManifestPath(archiveRoot, project, candidate))) continue;
      return candidate;
    }
    throw new Error(`Unable to allocate unique artifact archive id for ${sourceDir}`);
  }
}

type DirectoryStats = {
  fileCount: number;
  totalBytes: number;
};

async function assertDirectory(sourceDir: string): Promise<void> {
  let sourceStat;
  try {
    sourceStat = await lstat(sourceDir);
  } catch {
    throw new Error(`Artifact source directory not found: ${sourceDir}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`Artifact source is not a directory: ${sourceDir}`);
  }
}

async function collectDirectoryStats(dir: string): Promise<DirectoryStats> {
  const entries = await readdir(dir, { withFileTypes: true });
  let fileCount = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = await collectDirectoryStats(entryPath);
      fileCount += child.fileCount;
      totalBytes += child.totalBytes;
    } else if (entry.isFile()) {
      const fileStat = await stat(entryPath);
      fileCount += 1;
      totalBytes += fileStat.size;
    }
  }

  return { fileCount, totalBytes };
}

async function moveSourceToTrash(sourceDir: string, trashRoot?: string): Promise<string> {
  const target = nextTrashTarget(sourceDir, trashRoot);
  await mkdir(dirname(target), { recursive: true });
  await rename(sourceDir, target).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to move artifact source to Trash: ${message}`);
  });
  return target;
}

async function writeManifest(manifestPath: string, manifest: ArtifactArchiveManifest): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(artifactArchiveManifestSchema.parse(manifest), null, 2)}\n`, "utf-8");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readManifest(manifestPath: string): Promise<ArtifactArchiveManifest> {
  return artifactArchiveManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf-8")));
}
