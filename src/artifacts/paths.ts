import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { existsSync } from "node:fs";

export const DEFAULT_ARTIFACT_ARCHIVE_ROOT = join(
  homedir(),
  ".openclaw",
  "cold-storage",
  "artifact-archives",
);

export const ARTIFACT_INDEX_FILENAME = "artifact-archive-index.sqlite3";

export function resolveArchiveRoot(archiveRoot?: string): string {
  return resolve(archiveRoot ?? DEFAULT_ARTIFACT_ARCHIVE_ROOT);
}

export function resolveIndexPath(archiveRoot: string, dbPath?: string): string {
  return resolve(dbPath ?? join(archiveRoot, ARTIFACT_INDEX_FILENAME));
}

export function slugifyArtifactPart(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "artifact";
}

export function formatArchiveTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function buildArchiveId(date: Date, project: string, sourceDir: string): string {
  return `${formatArchiveTimestamp(date)}-${slugifyArtifactPart(project)}-${slugifyArtifactPart(basename(sourceDir))}`;
}

export function archivePayloadPath(archiveRoot: string, project: string, archiveId: string): string {
  return join(archiveRoot, slugifyArtifactPart(project), `${archiveId}.tar.gz`);
}

export function archiveManifestPath(archiveRoot: string, project: string, archiveId: string): string {
  return join(archiveRoot, slugifyArtifactPart(project), `${archiveId}.manifest.json`);
}

export function defaultTrashRoot(): string {
  return join(homedir(), ".Trash");
}

export function nextTrashTarget(sourceDir: string, trashRoot = defaultTrashRoot()): string {
  const sourceName = basename(sourceDir);
  let candidate = join(trashRoot, sourceName);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = join(trashRoot, `${sourceName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}
