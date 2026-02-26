import { describe, it, expect, afterEach, afterAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getProjectMemoryStore, clearProjectMemoryCache } from "../project-memory.js";

const DIMS = 8;

function makeChunkInput(index: number, embedding: number[]) {
  return {
    filePath: `test-${index}.md`,
    chunkIndex: 0,
    content: `test content ${index}`,
    embedding,
  };
}

describe("Project Memory Isolation", () => {
  const testDir = join(tmpdir(), `aof-project-memory-test-${Date.now()}`);
  const projectARoot = join(testDir, "Projects", "alpha");
  const projectBRoot = join(testDir, "Projects", "beta");

  // Create project directories upfront
  mkdirSync(projectARoot, { recursive: true });
  mkdirSync(projectBRoot, { recursive: true });

  afterEach(() => {
    clearProjectMemoryCache();
  });

  afterAll(() => {
    clearProjectMemoryCache();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates separate DB and HNSW files per project", () => {
    const storeA = getProjectMemoryStore(projectARoot, DIMS);
    const storeB = getProjectMemoryStore(projectBRoot, DIMS);

    // Should be different instances
    expect(storeA.db).not.toBe(storeB.db);
    expect(storeA.hnsw).not.toBe(storeB.hnsw);
    expect(storeA.vectorStore).not.toBe(storeB.vectorStore);
    expect(storeA.searchEngine).not.toBe(storeB.searchEngine);
  });

  it("returns cached store on second access", () => {
    const store1 = getProjectMemoryStore(projectARoot, DIMS);
    const store2 = getProjectMemoryStore(projectARoot, DIMS);
    expect(store1).toBe(store2); // Same reference
  });

  it("isolates memory data between projects", () => {
    const storeA = getProjectMemoryStore(projectARoot, DIMS);
    const storeB = getProjectMemoryStore(projectBRoot, DIMS);

    // Add a chunk to project A
    const embedding = [1, 0, 0, 0, 0, 0, 0, 0];
    storeA.vectorStore.insertChunk(makeChunkInput(0, embedding));

    // Project A should have 1 chunk (check via HNSW count)
    expect(storeA.hnsw.count).toBe(1);

    // Project B should have 0 chunks
    expect(storeB.hnsw.count).toBe(0);

    // Search in Project B should return nothing
    const results = storeB.vectorStore.search(embedding, 5);
    expect(results).toHaveLength(0);

    // Search in Project A should find the chunk
    const resultsA = storeA.vectorStore.search(embedding, 5);
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].content).toBe("test content 0");
  });

  it("inherits Phase 4 parity check on initialization", () => {
    // Create a store, add data, clear cache, re-initialize
    // The parity check should run and find no issues
    const store = getProjectMemoryStore(projectARoot, DIMS);
    store.vectorStore.insertChunk(
      makeChunkInput(1, [0, 1, 0, 0, 0, 0, 0, 0]),
    );

    // Verify data was added
    expect(store.hnsw.count).toBeGreaterThanOrEqual(1);

    // Clear cache forces re-initialization (parity check will run)
    clearProjectMemoryCache();

    // Re-get should succeed (parity check passes, data survives)
    const store2 = getProjectMemoryStore(projectARoot, DIMS);
    expect(store2.hnsw.count).toBeGreaterThanOrEqual(1);
  });

  it("project memory stores use correct file paths", () => {
    const storeA = getProjectMemoryStore(projectARoot, DIMS);
    expect(storeA.hnswPath).toBe(join(projectARoot, "memory", "memory-hnsw.dat"));

    const storeB = getProjectMemoryStore(projectBRoot, DIMS);
    expect(storeB.hnswPath).toBe(join(projectBRoot, "memory", "memory-hnsw.dat"));
  });

  it("hybrid search engine is isolated per project", () => {
    const storeA = getProjectMemoryStore(projectARoot, DIMS);
    const storeB = getProjectMemoryStore(projectBRoot, DIMS);

    // Add a chunk to project A via insertChunk (populates both vector and SQLite)
    const embeddingA = [1, 0, 0, 0, 0, 0, 0, 0];
    storeA.vectorStore.insertChunk(makeChunkInput(10, embeddingA));

    // Add a different chunk to project B
    const embeddingB = [0, 0, 0, 0, 0, 0, 0, 1];
    storeB.vectorStore.insertChunk(makeChunkInput(20, embeddingB));

    // Search project A for its own embedding
    const resultsA = storeA.searchEngine.search({
      query: "test",
      embedding: embeddingA,
      limit: 5,
    });
    expect(resultsA.length).toBeGreaterThanOrEqual(1);
    // The content from project A should appear, not project B
    const contentsA = resultsA.map((r) => r.content);
    expect(contentsA).toContain("test content 10");
    expect(contentsA).not.toContain("test content 20");

    // Search project B for its own embedding
    const resultsB = storeB.searchEngine.search({
      query: "test",
      embedding: embeddingB,
      limit: 5,
    });
    expect(resultsB.length).toBeGreaterThanOrEqual(1);
    const contentsB = resultsB.map((r) => r.content);
    expect(contentsB).toContain("test content 20");
    expect(contentsB).not.toContain("test content 10");
  });
});
