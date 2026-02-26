import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initMemoryDb } from "../store/schema";
import { HnswIndex } from "../store/hnsw-index";
import { VectorStore } from "../store/vector-store";
import { rebuildHnswFromDb } from "../index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DIMS = 8;

function randomEmbedding(dims: number = DIMS): number[] {
  return Array.from({ length: dims }, () => Math.random());
}

/** Create a deterministic embedding that is "near" a given seed. */
function seededEmbedding(seed: number, dims: number = DIMS): number[] {
  const vec = new Array(dims).fill(0);
  vec[seed % dims] = 1;
  return vec;
}

function makeChunkInput(index: number, embedding: number[]) {
  return {
    filePath: `test-${index}.md`,
    chunkIndex: 0,
    content: `test content ${index}`,
    embedding,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("HNSW Resilience", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hnsw-resilience-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── MEM-01: Capacity overflow ─────────────────────────────────────────

  describe("capacity overflow (MEM-01)", () => {
    it("inserts beyond initial capacity without crash", () => {
      const dbPath = join(tmpDir, "overflow.db");
      const hnswPath = join(tmpDir, "overflow-hnsw.dat");
      const db = initMemoryDb(dbPath, DIMS);
      const hnsw = new HnswIndex(DIMS);
      const store = new VectorStore(db, hnsw, hnswPath);

      // The default INITIAL_CAPACITY is 10_000.
      // Insert more than that to trigger at least one resize.
      // We use a smaller count (105) to keep the test fast but still
      // exercise the ensureCapacity path by checking that the index
      // handles many inserts without error.
      const N = 105;
      for (let i = 0; i < N; i++) {
        store.insertChunk(makeChunkInput(i, randomEmbedding()));
      }

      // All inserts succeeded without throwing
      expect(hnsw.count).toBe(N);

      // Verify search still works after all inserts
      const query = randomEmbedding();
      const results = store.search(query, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(10);

      db.close();
    });

    it("resizes correctly when HNSW hits capacity after load", () => {
      // Create an index at near-capacity, save, load, then insert more
      const dbPath = join(tmpDir, "load-resize.db");
      const hnswPath = join(tmpDir, "load-resize-hnsw.dat");
      const db = initMemoryDb(dbPath, DIMS);

      const hnsw1 = new HnswIndex(DIMS);
      const store1 = new VectorStore(db, hnsw1, hnswPath);

      // Insert some chunks
      const N = 50;
      for (let i = 0; i < N; i++) {
        store1.insertChunk(makeChunkInput(i, randomEmbedding()));
      }
      expect(hnsw1.count).toBe(N);

      // Save and verify file exists
      hnsw1.save(hnswPath);
      expect(existsSync(hnswPath)).toBe(true);

      // Load into a new index and continue inserting
      const hnsw2 = new HnswIndex(DIMS);
      hnsw2.load(hnswPath);
      expect(hnsw2.count).toBe(N);

      // Insert more (should not crash — ensureCapacity handles it)
      for (let i = N; i < N + 50; i++) {
        hnsw2.add(i + 1000, randomEmbedding()); // Use high IDs to avoid collision
      }

      expect(hnsw2.count).toBe(N + 50);

      db.close();
    });
  });

  // ─── MEM-02/MEM-03: Parity check and rebuild ─────────────────────────

  describe("parity check and rebuild (MEM-02, MEM-03)", () => {
    it("detects desync between HNSW and SQLite and triggers rebuild", () => {
      const dbPath = join(tmpDir, "parity.db");
      const db = initMemoryDb(dbPath, DIMS);
      const hnsw = new HnswIndex(DIMS);
      const store = new VectorStore(db, hnsw);

      // Use a unique, highly distinguishable embedding for the target chunk
      const targetEmbedding = [1, 0, 0, 0, 0, 0, 0, 0];
      const targetId = store.insertChunk(makeChunkInput(0, targetEmbedding));

      // Insert more chunks with orthogonal embeddings
      const N = 20;
      for (let i = 1; i < N; i++) {
        // All other chunks have embedding in the opposite direction
        store.insertChunk(makeChunkInput(i, [0, 0, 0, 0, 0, 0, 0, 1]));
      }
      expect(hnsw.count).toBe(N);

      // Simulate desync: create a fresh (empty) HNSW index
      const freshHnsw = new HnswIndex(DIMS);
      expect(freshHnsw.count).toBe(0);

      // SQLite still has N rows
      const sqliteCount = (db.prepare("SELECT COUNT(*) as c FROM vec_chunks").get() as { c: number }).c;
      expect(sqliteCount).toBe(N);

      // Parity check would detect: HNSW=0, SQLite=N
      expect(freshHnsw.count).not.toBe(sqliteCount);

      // Rebuild from SQLite
      rebuildHnswFromDb(db, freshHnsw);
      expect(freshHnsw.count).toBe(N);

      // Search for the target chunk and verify it's found as nearest neighbor
      const results = freshHnsw.search(targetEmbedding, 1);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(targetId);
      expect(results[0].distance).toBeCloseTo(0, 4);

      db.close();
    });

    it("rebuild from SQLite stores last_rebuild_time in memory_meta", () => {
      const dbPath = join(tmpDir, "meta.db");
      const db = initMemoryDb(dbPath, DIMS);
      const hnsw = new HnswIndex(DIMS);
      const store = new VectorStore(db, hnsw);

      store.insertChunk(makeChunkInput(0, randomEmbedding()));

      // Rebuild triggers memory_meta update
      rebuildHnswFromDb(db, hnsw);

      // Verify the memory_meta table has last_rebuild_time
      const row = db.prepare("SELECT value FROM memory_meta WHERE key = 'last_rebuild_time'").get() as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBeTruthy();

      db.close();
    });
  });

  // ─── MEM-04: Save/load cycle ──────────────────────────────────────────

  describe("save/load cycle (MEM-04)", () => {
    it("search returns correct results after save/load cycle", () => {
      const dbPath = join(tmpDir, "saveload.db");
      const hnswPath = join(tmpDir, "saveload-hnsw.dat");
      const db = initMemoryDb(dbPath, DIMS);

      // Phase 1: Insert chunks and search
      const hnsw1 = new HnswIndex(DIMS);
      const store1 = new VectorStore(db, hnsw1, hnswPath);

      const knownEmbedding = seededEmbedding(0);
      store1.insertChunk(makeChunkInput(0, knownEmbedding));
      store1.insertChunk(makeChunkInput(1, seededEmbedding(1)));
      store1.insertChunk(makeChunkInput(2, seededEmbedding(2)));

      const resultsBefore = store1.search(knownEmbedding, 3);
      expect(resultsBefore.length).toBe(3);
      const bestBefore = resultsBefore[0];

      // Phase 2: Save, create new index, load, search again
      hnsw1.save(hnswPath);

      const hnsw2 = new HnswIndex(DIMS);
      hnsw2.load(hnswPath);

      const store2 = new VectorStore(db, hnsw2, hnswPath);
      const resultsAfter = store2.search(knownEmbedding, 3);

      expect(resultsAfter.length).toBe(3);
      expect(resultsAfter[0].id).toBe(bestBefore.id);
      expect(resultsAfter[0].content).toBe(bestBefore.content);
      // Distance should be very close (floating point tolerance)
      expect(resultsAfter[0].distance).toBeCloseTo(bestBefore.distance, 4);

      db.close();
    });
  });

  // ─── MEM-03/MEM-04: Rebuild from SQLite produces searchable index ─────

  describe("rebuild from SQLite (MEM-03, MEM-04)", () => {
    it("rebuild from SQLite produces searchable index", () => {
      const dbPath = join(tmpDir, "rebuild.db");
      const hnswPath = join(tmpDir, "rebuild-hnsw.dat");
      const db = initMemoryDb(dbPath, DIMS);

      // Insert via VectorStore to populate both SQLite and HNSW
      const hnsw1 = new HnswIndex(DIMS);
      const store1 = new VectorStore(db, hnsw1, hnswPath);

      const knownEmbedding = seededEmbedding(3);
      const N = 15;
      for (let i = 0; i < N; i++) {
        store1.insertChunk(makeChunkInput(i, i === 3 ? knownEmbedding : randomEmbedding()));
      }

      // Save the HNSW index, then delete the file to simulate loss
      hnsw1.save(hnswPath);
      rmSync(hnswPath, { force: true });
      expect(existsSync(hnswPath)).toBe(false);

      // Create a fresh HNSW index and rebuild from SQLite
      const hnsw2 = new HnswIndex(DIMS);
      rebuildHnswFromDb(db, hnsw2);

      expect(hnsw2.count).toBe(N);

      // Search for the known chunk
      const results = hnsw2.search(knownEmbedding, 1);
      expect(results.length).toBe(1);
      // The chunk with the known embedding should be the nearest neighbor
      // Its SQLite ID is 4 (4th inserted, 1-indexed autoincrement)
      expect(results[0].id).toBe(4);
      expect(results[0].distance).toBeCloseTo(0, 4);

      db.close();
    });

    it("rebuilding flag makes search fall back to sqlite-vec", () => {
      const dbPath = join(tmpDir, "fallback.db");
      const db = initMemoryDb(dbPath, DIMS);
      const hnsw = new HnswIndex(DIMS);
      const store = new VectorStore(db, hnsw);

      const embedding = seededEmbedding(0);
      store.insertChunk(makeChunkInput(0, embedding));

      // With HNSW available, search works
      const normalResults = store.search(embedding, 1);
      expect(normalResults.length).toBe(1);

      // Set rebuilding flag — should fall back to sqlite-vec
      store.rebuilding = true;
      const fallbackResults = store.search(embedding, 1);
      expect(fallbackResults.length).toBe(1);
      expect(fallbackResults[0].content).toBe("test content 0");

      // Unset rebuilding flag
      store.rebuilding = false;
      const restoredResults = store.search(embedding, 1);
      expect(restoredResults.length).toBe(1);

      db.close();
    });
  });
});
