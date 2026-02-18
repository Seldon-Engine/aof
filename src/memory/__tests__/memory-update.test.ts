import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../embeddings/provider";
import { initMemoryDb } from "../store/schema";
import { FtsStore } from "../store/fts-store";
import { VectorStore } from "../store/vector-store";
import { createMemoryStoreTool } from "../tools/store";
import { createMemoryUpdateTool } from "../tools/update";

const EMBEDDING_DIMENSIONS = 4;

describe("memory_update tool", () => {
  let db: ReturnType<typeof initMemoryDb>;
  let vectorStore: VectorStore;
  let ftsStore: FtsStore;
  let embeddingProvider: EmbeddingProvider;

  beforeEach(() => {
    db = initMemoryDb(":memory:", EMBEDDING_DIMENSIONS);
    vectorStore = new VectorStore(db);
    ftsStore = new FtsStore(db);

    embeddingProvider = {
      dimensions: EMBEDDING_DIMENSIONS,
      embed: async (texts: string[]) =>
        texts.map((text) =>
          text.includes("beta") ? [0, 1, 0, 0] : [1, 0, 0, 0],
        ),
    };
  });

  afterEach(() => {
    db.close();
  });

  it("updates the file and re-indexes chunks", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-update-"));
    const poolPaths = { core: dir };

    const storeTool = createMemoryStoreTool({
      embeddingProvider,
      vectorStore,
      ftsStore,
      db,
      poolPaths,
      defaultPool: "core",
    });

    const storeResult = await storeTool.execute("test", {
      content: "alpha line 1",
      pool: "core",
      tags: ["alpha"],
    });

    const storeMatch = /Stored memory at (.*) \(chunks:/.exec(
      storeResult.content[0].text,
    );
    const filePath = storeMatch?.[1] ?? "";

    const updateTool = createMemoryUpdateTool({
      embeddingProvider,
      vectorStore,
      ftsStore,
      db,
    });

    const updateResult = await updateTool.execute("test", {
      path: filePath,
      content: "beta line 1",
      tags: ["beta"],
      tier: "warm",
    });

    expect(updateResult.content[0].text).toContain("Updated memory at");

    const fileContent = readFileSync(filePath, "utf-8");
    expect(fileContent).toContain("beta line 1");
    expect(fileContent).toContain("- beta");
    expect(fileContent).toContain("tier: warm");

    const vectorResults = vectorStore.search([0, 1, 0, 0], 5);
    expect(vectorResults[0]?.content).toContain("beta line 1");
  });

  it("skips reindexing when no changes are detected", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-update-skip-"));
    const poolPaths = { core: dir };

    const storeTool = createMemoryStoreTool({
      embeddingProvider,
      vectorStore,
      ftsStore,
      db,
      poolPaths,
      defaultPool: "core",
    });

    const storeResult = await storeTool.execute("test", {
      content: "alpha line 1",
      pool: "core",
    });

    const storeMatch = /Stored memory at (.*) \(chunks:/.exec(
      storeResult.content[0].text,
    );
    const filePath = storeMatch?.[1] ?? "";

    const updateTool = createMemoryUpdateTool({
      embeddingProvider,
      vectorStore,
      ftsStore,
      db,
    });

    const updateResult = await updateTool.execute("test", { path: filePath });

    expect(updateResult.content[0].text).toBe(
      `No changes detected for ${filePath}.`,
    );
  });
});
