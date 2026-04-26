import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  artifactArchiveIndexRowSchema,
  type ArtifactArchiveIndexRow,
  type ArtifactArchiveRecord,
} from "./schema.js";

type SqliteDb = InstanceType<typeof Database>;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS artifact_archives (
    id text primary key,
    schema_version integer not null,
    project text not null,
    title text not null,
    source_path text not null,
    archive_path text not null,
    manifest_path text not null,
    sha256 text not null,
    file_count integer not null,
    original_bytes integer not null,
    archive_bytes integer not null,
    created_at text not null,
    tags_json text not null,
    notes text,
    destructive_prune_performed integer not null default 0,
    trash_path text
  );
  CREATE INDEX IF NOT EXISTS idx_artifact_archives_project ON artifact_archives(project);
  CREATE INDEX IF NOT EXISTS idx_artifact_archives_created_at ON artifact_archives(created_at);
`;

export class ArtifactArchiveStore {
  private readonly db: SqliteDb;

  private constructor(db: SqliteDb) {
    this.db = db;
  }

  static async open(dbPath: string): Promise<ArtifactArchiveStore> {
    await mkdir(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(CREATE_TABLE_SQL);
    return new ArtifactArchiveStore(db);
  }

  static openExisting(dbPath: string): ArtifactArchiveStore | undefined {
    if (!existsSync(dbPath)) return undefined;
    const db = new Database(dbPath);
    db.exec(CREATE_TABLE_SQL);
    return new ArtifactArchiveStore(db);
  }

  close(): void {
    this.db.close();
  }

  has(id: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM artifact_archives WHERE id = ?").get(id);
    return row !== undefined;
  }

  insert(row: ArtifactArchiveIndexRow): void {
    const parsed = artifactArchiveIndexRowSchema.parse(row);
    this.db.prepare(`
      INSERT INTO artifact_archives (
        id, schema_version, project, title, source_path, archive_path, manifest_path,
        sha256, file_count, original_bytes, archive_bytes, created_at, tags_json,
        notes, destructive_prune_performed, trash_path
      ) VALUES (
        @id, @schema_version, @project, @title, @source_path, @archive_path, @manifest_path,
        @sha256, @file_count, @original_bytes, @archive_bytes, @created_at, @tags_json,
        @notes, @destructive_prune_performed, @trash_path
      )
    `).run(parsed);
  }

  markPruned(id: string, trashPath: string): void {
    this.db.prepare(`
      UPDATE artifact_archives
      SET destructive_prune_performed = 1, trash_path = ?
      WHERE id = ?
    `).run(trashPath, id);
  }

  get(id: string): ArtifactArchiveRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifact_archives WHERE id = ?").get(id);
    if (row === undefined) return undefined;
    return toRecord(artifactArchiveIndexRowSchema.parse(row));
  }

  list(limit: number): ArtifactArchiveRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM artifact_archives
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    return rows.map((row) => toRecord(artifactArchiveIndexRowSchema.parse(row)));
  }
}

function toRecord(row: ArtifactArchiveIndexRow): ArtifactArchiveRecord {
  return {
    ...row,
    notes: row.notes ?? undefined,
    trash_path: row.trash_path ?? undefined,
    tags: JSON.parse(row.tags_json) as string[],
    destructive_prune_performed: row.destructive_prune_performed === 1,
  };
}
