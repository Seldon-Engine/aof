import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../embeddings/provider";
import { initMemoryDb } from "../store/schema";
import { FtsStore } from "../store/fts-store";
import { VectorStore } from "../store/vector-store";
import { createMemoryListTool } from "../tools/list";
import { createMemoryStoreTool } from "../tools/store";

const EMBEDDING_DIMENSIONS = 4;

describe("memory_list tool", () => {
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
          text.includes("alpha") ? [1, 0, 0, 0] : [0, 1, 0, 0],
        ),
    };
  });

  afterEach(() => {
    db.close();
  });

  it("lists memories with optional filters", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-list-"));
    const poolPaths = { core: dir, archive: dir };

    const storeTool = createMemoryStoreTool({
      embeddingProvider,
      vectorStore,
      ftsStore,
      db,
      poolPaths,
      defaultPool: "core",
    });

    await storeTool.execute("test", {
      content: "alpha content",
      pool: "core",
      tier: "hot",
      tags: ["alpha", "shared"],
    });

    await storeTool.execute("test", {
      content: "beta content",
      pool: "archive",
      tier: "cold",
      tags: ["beta"],
    });

    const listTool = createMemoryListTool({ db, defaultLimit: 10 });

    const all = await listTool.execute("test", {});
    expect(all.content[0].text.split("\n")).toHaveLength(2);

    const filtered = await listTool.execute("test", {
      pool: "core",
      tier: "hot",
      tags: ["alpha"],
    });

    expect(filtered.content[0].text).toContain("tier: hot");
    expect(filtered.content[0].text).toContain("pool: core");
    expect(filtered.content[0].text).toContain("tags: alpha, shared");
    expect(filtered.content[0].text).not.toContain("pool: archive");
  });

  it("returns a friendly message when no memories match", async () => {
    const listTool = createMemoryListTool({ db, defaultLimit: 10 });
    const result = await listTool.execute("test", { pool: "missing" });
    expect(result.content[0].text).toBe("No memories found.");
  });
});
