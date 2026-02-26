import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initMemoryDb } from "../../memory/store/schema";
import { HnswIndex } from "../../memory/store/hnsw-index";
import { computeHealthReport } from "../commands/memory";
import type { SqliteDb } from "../../memory/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DIMS = 8;

function randomEmbedding(dims: number = DIMS): number[] {
  return Array.from({ length: dims }, () => Math.random());
}

function insertChunk(
  db: SqliteDb,
  hnsw: HnswIndex,
  opts: { id?: number; pool?: string } = {},
): number {
  const embedding = randomEmbedding();
  const now = Date.now();
  const pool = opts.pool ?? "core";

  const result = db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, tier, pool, importance, tags, created_at, updated_at, accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`test-${now}-${Math.random()}.md`, 0, "test content", "hot", pool, 1.0, null, now, now, now);

  const chunkId = Number(result.lastInsertRowid);

  db.prepare("INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)").run(
    BigInt(chunkId),
    new Float32Array(embedding),
  );

  hnsw.add(chunkId, embedding);

  return chunkId;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("computeHealthReport", () => {
  let tmpDir: string;
  let db: SqliteDb;
  let hnsw: HnswIndex;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "health-test-"));
    const dbPath = join(tmpDir, "memory.db");
    db = initMemoryDb(dbPath, DIMS);
    db.exec("CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)");
    hnsw = new HnswIndex(DIMS);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns ok sync status when counts match", () => {
    insertChunk(db, hnsw);
    insertChunk(db, hnsw);
    insertChunk(db, hnsw);

    const report = computeHealthReport(db, hnsw);

    expect(report.syncStatus).toBe("ok");
    expect(report.hnswCount).toBe(3);
    expect(report.sqliteCount).toBe(3);
  });

  it("returns desynced status when counts differ", () => {
    // Insert 3 chunks into both SQLite and HNSW
    insertChunk(db, hnsw);
    insertChunk(db, hnsw);
    insertChunk(db, hnsw);

    // Add an extra embedding directly to HNSW (not in SQLite)
    hnsw.add(9999, randomEmbedding());

    const report = computeHealthReport(db, hnsw);

    expect(report.syncStatus).toBe("desynced");
    expect(report.hnswCount).toBe(4);
    expect(report.sqliteCount).toBe(3);
  });

  it("computes fragmentation percentage correctly", () => {
    // With a fresh index, maxElements is INITIAL_CAPACITY (10000) and count is 0
    // After adding chunks, fragmentation = (maxElements - count) / maxElements * 100
    insertChunk(db, hnsw);
    insertChunk(db, hnsw);

    const report = computeHealthReport(db, hnsw);

    // maxElements = 10000, count = 2
    // frag = (10000 - 2) / 10000 * 100 = 99.98%
    expect(report.fragmentationPct).toBe(100.0); // rounds to 100.0 at this scale
    // More precisely: (10000-2)/10000 = 0.9998 * 100 = 99.98
    // Actually let's check the real value
    const expected = Math.round(((hnsw.maxElements - hnsw.count) / hnsw.maxElements) * 1000) / 10;
    expect(report.fragmentationPct).toBe(expected);
  });

  it("returns null for last rebuild time when never rebuilt", () => {
    // memory_meta table exists but has no last_rebuild_time entry
    const report = computeHealthReport(db, hnsw);

    expect(report.lastRebuildTime).toBeNull();
  });

  it("returns last rebuild time when set", () => {
    db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('last_rebuild_time', '2026-02-26 10:30:00')").run();

    const report = computeHealthReport(db, hnsw);

    expect(report.lastRebuildTime).toBe("2026-02-26 10:30:00");
  });

  it("includes per-pool breakdown", () => {
    insertChunk(db, hnsw, { pool: "core" });
    insertChunk(db, hnsw, { pool: "core" });
    insertChunk(db, hnsw, { pool: "agent-main" });
    insertChunk(db, hnsw, { pool: "agent-swe-ai" });
    insertChunk(db, hnsw, { pool: "agent-swe-ai" });
    insertChunk(db, hnsw, { pool: "agent-swe-ai" });

    const report = computeHealthReport(db, hnsw);

    expect(report.pools).toHaveLength(3);

    const byPool = new Map(report.pools.map((p) => [p.pool, p.count]));
    expect(byPool.get("core")).toBe(2);
    expect(byPool.get("agent-main")).toBe(1);
    expect(byPool.get("agent-swe-ai")).toBe(3);
  });

  it("handles empty database gracefully", () => {
    const report = computeHealthReport(db, hnsw);

    expect(report.hnswCount).toBe(0);
    expect(report.sqliteCount).toBe(0);
    expect(report.syncStatus).toBe("ok");
    expect(report.fragmentationPct).toBe(100); // empty index: all capacity is "fragmented"
    expect(report.lastRebuildTime).toBeNull();
    expect(report.pools).toHaveLength(0);
  });
});
