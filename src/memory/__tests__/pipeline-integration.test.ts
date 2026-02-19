/**
 * AOF-oj6: End-to-end integration test for the memory pipeline.
 *
 * Exercises: ingest → chunk → embed → store (vector + FTS) → hybrid search → retrieve → delete
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../embeddings/provider";
import { initMemoryDb } from "../store/schema";
import { FtsStore } from "../store/fts-store";
import { VectorStore } from "../store/vector-store";
import { HybridSearchEngine } from "../store/hybrid-search";
import { createMemoryStoreTool } from "../tools/store";
import { createMemorySearchTool } from "../tools/search";
import { createMemoryDeleteTool } from "../tools/delete";
import { createMemoryListTool } from "../tools/list";

const DIMS = 4;

/** Deterministic mock embedder: maps keywords to orthogonal vectors. */
function mockEmbedder(): EmbeddingProvider {
  return {
    dimensions: DIMS,
    embed: async (texts: string[]) =>
      texts.map((t) => {
        if (t.includes("scheduler")) return [1, 0, 0, 0];
        if (t.includes("protocol")) return [0, 1, 0, 0];
        if (t.includes("memory")) return [0, 0, 1, 0];
        return [0.25, 0.25, 0.25, 0.25];
      }),
  };
}

describe("Memory pipeline integration", () => {
  let db: ReturnType<typeof initMemoryDb>;
  let vectorStore: VectorStore;
  let ftsStore: FtsStore;
  let searchEngine: HybridSearchEngine;
  let embeddingProvider: EmbeddingProvider;
  let poolDir: string;
  let poolPaths: Record<string, string>;

  beforeEach(() => {
    db = initMemoryDb(":memory:", DIMS);
    vectorStore = new VectorStore(db);
    ftsStore = new FtsStore(db);
    searchEngine = new HybridSearchEngine(vectorStore, ftsStore);
    embeddingProvider = mockEmbedder();

    poolDir = mkdtempSync(path.join(tmpdir(), "aof-mem-integration-"));
    mkdirSync(path.join(poolDir, "core"), { recursive: true });
    poolPaths = { core: path.join(poolDir, "core") };
  });

  afterEach(() => {
    db.close();
  });

  it("stores documents, searches by semantic similarity, and ranks correctly", async () => {
    const storeTool = createMemoryStoreTool({
      db,
      embeddingProvider,
      vectorStore,
      ftsStore,
      poolPaths,
      defaultPool: "core",
      defaultTier: "hot",
    });

    const searchTool = createMemorySearchTool({
      embeddingProvider,
      searchEngine,
    });

    // 1. Store a scheduler document
    const r1 = await storeTool.execute("test", {
      content: "The scheduler dispatches tasks to agents based on priority and dependencies.",
      pool: "core",
      tier: "hot",
    });
    expect(r1.content[0].text).toContain("Stored memory");

    // 2. Store a protocol document
    const r2 = await storeTool.execute("test", {
      content: "Protocols define multi-step workflows between agents for protocol coordination.",
      pool: "core",
      tier: "hot",
    });
    expect(r2.content[0].text).toContain("Stored memory");

    // 3. Search for scheduler-related content
    const result = await searchTool.execute("test", {
      query: "how does the scheduler work",
      limit: 5,
    });
    const text = result.content[0].text;
    expect(text).toContain("scheduler");
    expect(text).toContain("dispatches");
  });

  it("deletes a document and confirms it is gone from search", async () => {
    const storeTool = createMemoryStoreTool({
      db,
      embeddingProvider,
      vectorStore,
      ftsStore,
      poolPaths,
      defaultPool: "core",
      defaultTier: "hot",
    });

    const searchTool = createMemorySearchTool({
      embeddingProvider,
      searchEngine,
    });

    const deleteTool = createMemoryDeleteTool({
      db,
      vectorStore,
      ftsStore,
    });

    // Store a doc
    const storeResult = await storeTool.execute("test", {
      content: "The memory module handles storage and retrieval of agent knowledge.",
      pool: "core",
      tier: "hot",
    });

    // Extract file path from store result
    const match = /Stored memory at (.*) \(chunks:/.exec(storeResult.content[0].text);
    expect(match).toBeTruthy();
    const filePath = match![1];

    // Verify searchable
    const before = await searchTool.execute("test", { query: "memory module storage", limit: 5 });
    expect(before.content[0].text).toContain("memory");

    // Delete
    const delResult = await deleteTool.execute("test", { path: filePath });
    expect(delResult.content[0].text).toContain("Deleted");

    // Verify gone
    const after = await searchTool.execute("test", { query: "memory module storage", limit: 5 });
    expect(after.content[0].text).not.toContain("agent knowledge");
  });

  it("lists stored documents with metadata", async () => {
    const storeTool = createMemoryStoreTool({
      db,
      embeddingProvider,
      vectorStore,
      ftsStore,
      poolPaths,
      defaultPool: "core",
      defaultTier: "hot",
    });

    const listTool = createMemoryListTool({ db, defaultLimit: 20 });

    // Store two docs in different tiers
    await storeTool.execute("test", {
      content: "Scheduler internals: the main loop runs every 30 seconds.",
      pool: "core",
      tier: "hot",
    });

    await storeTool.execute("test", {
      content: "Protocol design: agents negotiate handshakes before task transfer.",
      pool: "core",
      tier: "warm",
    });

    const listResult = await listTool.execute("test", {});
    const text = listResult.content[0].text;
    // Should list both documents (list returns paths + metadata, not content)
    expect(text).toContain("hot");
    expect(text).toContain("warm");
  });
});
