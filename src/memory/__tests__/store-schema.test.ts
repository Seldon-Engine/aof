import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initMemoryDb } from "../store";

const createDbPath = () =>
  path.join(mkdtempSync(path.join(tmpdir(), "aof-memory-")), "memory.db");

const requiredTables = ["files", "chunks", "vec_chunks", "fts_chunks"];

const listTables = (db: ReturnType<typeof initMemoryDb>) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('files', 'chunks', 'vec_chunks', 'fts_chunks')",
    )
    .all()
    .map((row) => row.name)
    .sort();

describe("initMemoryDb", () => {
  it("creates memory tables and virtual tables", () => {
    const db = initMemoryDb(createDbPath(), 8);
    const tables = listTables(db);

    expect(tables).toEqual([...requiredTables].sort());

    db.close();
  });

  it("is re-entrant for existing databases", () => {
    const dbPath = createDbPath();
    const first = initMemoryDb(dbPath, 8);
    first.close();

    const second = initMemoryDb(dbPath, 8);
    const tables = listTables(second);

    expect(tables).toEqual([...requiredTables].sort());

    second.close();
  });
});
