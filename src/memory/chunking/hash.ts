import { createHash } from "node:crypto";

import type { SqliteDb } from "../types.js";

export const computeFileHash = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export const hasFileChanged = (
  db: SqliteDb,
  filePath: string,
  currentHash: string,
): boolean => {
  const row = db
    .prepare("SELECT hash FROM files WHERE path = ?")
    .get(filePath) as { hash: string } | undefined;

  if (!row) {
    return true;
  }

  return row.hash !== currentHash;
};

export const updateFileRecord = (
  db: SqliteDb,
  filePath: string,
  hash: string,
  chunkCount: number,
  tier?: string,
  pool?: string,
): void => {
  const indexedAt = Date.now();
  db.prepare(
    `INSERT INTO files (path, hash, chunk_count, tier, pool, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       hash = excluded.hash,
       chunk_count = excluded.chunk_count,
       tier = excluded.tier,
       pool = excluded.pool,
       indexed_at = excluded.indexed_at`,
  ).run(filePath, hash, chunkCount, tier ?? null, pool ?? null, indexedAt);
};
