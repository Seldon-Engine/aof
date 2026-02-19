import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { computeFileHash, hasFileChanged, updateFileRecord } from "../chunking/hash";
import { initMemoryDb } from "../store";
import { VectorStore } from "../store/vector-store";
import { FtsStore } from "../store/fts-store";
import type { EmbeddingProvider } from "../embeddings/provider";
import { IndexSyncService } from "../tools/indexing";

const createDbPath = () =>
  path.join(mkdtempSync(path.join(tmpdir(), "aof-memory-")), "memory.db");

describe("hash helpers", () => {
  it("computes stable sha256 hashes", () => {
    expect(computeFileHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("detects changes and updates file records", () => {
    const db = initMemoryDb(createDbPath(), 8);
    const filePath = "/notes/alpha.md";
    const hash = computeFileHash("alpha");

    expect(hasFileChanged(db, filePath, hash)).toBe(true);

    updateFileRecord(db, filePath, hash, 3, "hot", "core");

    expect(hasFileChanged(db, filePath, hash)).toBe(false);
    expect(hasFileChanged(db, filePath, computeFileHash("beta"))).toBe(true);

    db.close();
  });
});


const SYNC_DIM = 4;

describe("IndexSyncService", () => {
  let syncDb: ReturnType<typeof initMemoryDb>;
  let vStore: VectorStore;
  let fStore: FtsStore;
  let emb: EmbeddingProvider;
  let tmpSyncDir: string;

  beforeEach(() => {
    syncDb = initMemoryDb(":memory:", SYNC_DIM);
    vStore = new VectorStore(syncDb);
    fStore = new FtsStore(syncDb);
    tmpSyncDir = mkdtempSync(path.join(tmpdir(), "aof-sync-"));
    emb = {
      dimensions: SYNC_DIM,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
    };
  });

  afterEach(() => {
    syncDb.close();
    rmSync(tmpSyncDir, { recursive: true, force: true });
  });

  it("indexes new markdown files", async () => {
    writeFileSync(path.join(tmpSyncDir, "note.md"), "# Hello\nThis is a note.", "utf-8");
    const svc = new IndexSyncService({ db: syncDb, embeddingProvider: emb, vectorStore: vStore, ftsStore: fStore, indexPaths: [tmpSyncDir] });
    const result = await svc.runOnce();
    expect(result.scanned).toBe(1);
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("skips unchanged files on second run", async () => {
    writeFileSync(path.join(tmpSyncDir, "note.md"), "# Hello\nThis is a note.", "utf-8");
    const svc = new IndexSyncService({ db: syncDb, embeddingProvider: emb, vectorStore: vStore, ftsStore: fStore, indexPaths: [tmpSyncDir] });
    await svc.runOnce();
    const result = await svc.runOnce();
    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(0);
  });

  it("re-indexes when content changes", async () => {
    const fp = path.join(tmpSyncDir, "note.md");
    writeFileSync(fp, "# Hello\nOriginal.", "utf-8");
    const svc = new IndexSyncService({ db: syncDb, embeddingProvider: emb, vectorStore: vStore, ftsStore: fStore, indexPaths: [tmpSyncDir] });
    await svc.runOnce();
    writeFileSync(fp, "# Hello\nUpdated.", "utf-8");
    const result = await svc.runOnce();
    expect(result.indexed).toBe(1);
  });

  it("silently skips nonexistent paths", async () => {
    const svc = new IndexSyncService({ db: syncDb, embeddingProvider: emb, vectorStore: vStore, ftsStore: fStore, indexPaths: ["/tmp/aof-nonexistent-xyz-12345"] });
    const result = await svc.runOnce();
    expect(result.scanned).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("start and stop do not throw", () => {
    const svc = new IndexSyncService({ db: syncDb, embeddingProvider: emb, vectorStore: vStore, ftsStore: fStore, indexPaths: [], scanIntervalMs: 60_000 });
    svc.start();
    svc.stop();
  });
});
