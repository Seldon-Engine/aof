import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { computeFileHash, hasFileChanged, updateFileRecord } from "../chunking/hash";
import { initMemoryDb } from "../store";

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
