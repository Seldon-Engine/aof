import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initMemoryDb } from "../store/schema";
import { VectorStore } from "../store/vector-store";

const EMBEDDING_DIMENSIONS = 4;

describe("VectorStore", () => {
  let store: VectorStore;
  let db: ReturnType<typeof initMemoryDb>;

  beforeEach(() => {
    db = initMemoryDb(":memory:", EMBEDDING_DIMENSIONS);
    store = new VectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts chunks and returns nearest neighbors", () => {
    const firstId = store.insertChunk({
      filePath: "alpha.md",
      chunkIndex: 0,
      content: "alpha content",
      embedding: [0.1, 0.1, 0.1, 0.1],
      tags: ["alpha"],
    });

    const secondId = store.insertChunk({
      filePath: "beta.md",
      chunkIndex: 0,
      content: "beta content",
      embedding: [0.9, 0.9, 0.9, 0.9],
      tags: ["beta"],
    });

    const results = store.search([0.1, 0.1, 0.1, 0.1], 2);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(firstId);
    expect(results[1].id).toBe(secondId);
    expect(results[0].tags).toEqual(["alpha"]);
  });

  it("updates metadata and embeddings", () => {
    const chunkId = store.insertChunk({
      filePath: "alpha.md",
      chunkIndex: 1,
      content: "original",
      embedding: [0.2, 0.2, 0.2, 0.2],
    });

    store.updateChunk(chunkId, {
      content: "updated",
      embedding: [0.8, 0.8, 0.8, 0.8],
      tags: ["updated"],
    });

    const chunk = store.getChunk(chunkId);
    expect(chunk?.content).toBe("updated");
    expect(chunk?.tags).toEqual(["updated"]);

    const results = store.search([0.8, 0.8, 0.8, 0.8], 1);
    expect(results[0].id).toBe(chunkId);
  });

  it("deletes chunks by file", () => {
    const firstId = store.insertChunk({
      filePath: "gamma.md",
      chunkIndex: 0,
      content: "gamma",
      embedding: [0.3, 0.3, 0.3, 0.3],
    });

    store.insertChunk({
      filePath: "gamma.md",
      chunkIndex: 1,
      content: "gamma 2",
      embedding: [0.31, 0.31, 0.31, 0.31],
    });

    store.insertChunk({
      filePath: "delta.md",
      chunkIndex: 0,
      content: "delta",
      embedding: [0.9, 0.9, 0.9, 0.9],
    });

    const removed = store.deleteChunksByFile("gamma.md");

    expect(removed).toBe(2);
    expect(store.getChunk(firstId)).toBeNull();
    expect(store.search([0.3, 0.3, 0.3, 0.3], 5)).toHaveLength(1);
  });
});
