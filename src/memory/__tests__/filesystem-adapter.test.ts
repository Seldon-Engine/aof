import { describe, it, expect, beforeEach } from "vitest";
import { createFilesystemAdapter } from "../adapters/filesystem.js";
import type { MemoryPoolDefinition } from "../adapter.js";

describe("FilesystemAdapter", () => {
  let adapter: ReturnType<typeof createFilesystemAdapter>;

  beforeEach(() => {
    adapter = createFilesystemAdapter();
  });

  it("should have correct id and capabilities", () => {
    expect(adapter.id).toBe("filesystem");
    expect(adapter.capabilities.semantic).toBe(false);
    expect(adapter.capabilities.keyword).toBe(true);
  });

  it("should initialize without error", async () => {
    await expect(
      adapter.init?.({ dataDir: "/tmp", vaultRoot: "/vault" })
    ).resolves.toBeUndefined();
  });

  it("should register pools without error", async () => {
    const pools: MemoryPoolDefinition[] = [
      {
        id: "hot",
        tier: "hot",
        path: "/vault/memory/hot",
        agents: ["agent1", "agent2"],
      },
      {
        id: "warm-eng",
        tier: "warm",
        path: "/vault/memory/warm/engineering",
        roles: ["engineer"],
      },
    ];

    await expect(adapter.registerPools(pools)).resolves.toBeUndefined();
  });

  it("should no-op on indexPaths", async () => {
    await expect(
      adapter.indexPaths(["/path/to/file1.md", "/path/to/file2.md"])
    ).resolves.toBeUndefined();
  });

  it("should return empty results for recall (no semantic capability)", async () => {
    await adapter.init?.({ dataDir: "/tmp", vaultRoot: "/vault" });
    
    const pools: MemoryPoolDefinition[] = [
      {
        id: "hot",
        tier: "hot",
        path: "/vault/memory/hot",
      },
    ];
    await adapter.registerPools(pools);

    const results = await adapter.recall({
      agentId: "agent1",
      query: "test query",
      limit: 10,
    });

    expect(results).toEqual([]);
  });

  it("should filter by agent access", async () => {
    await adapter.init?.({ dataDir: "/tmp", vaultRoot: "/vault" });
    
    const pools: MemoryPoolDefinition[] = [
      {
        id: "restricted",
        tier: "hot",
        path: "/vault/restricted",
        agents: ["agent2"], // Only agent2 has access
      },
    ];
    await adapter.registerPools(pools);

    const results = await adapter.recall({
      agentId: "agent1",
      query: "test query",
    });

    expect(results).toEqual([]);
  });

  it("should filter by tier", async () => {
    await adapter.init?.({ dataDir: "/tmp", vaultRoot: "/vault" });
    
    const pools: MemoryPoolDefinition[] = [
      {
        id: "cold-archive",
        tier: "cold",
        path: "/vault/cold",
      },
    ];
    await adapter.registerPools(pools);

    const results = await adapter.recall({
      agentId: "agent1",
      query: "test query",
      tiers: ["hot", "warm"], // Don't include cold
    });

    expect(results).toEqual([]);
  });

  it("should report status", async () => {
    await adapter.init?.({ dataDir: "/tmp", vaultRoot: "/vault" });
    
    const pools: MemoryPoolDefinition[] = [
      { id: "hot", tier: "hot", path: "/vault/hot" },
      { id: "warm", tier: "warm", path: "/vault/warm" },
    ];
    await adapter.registerPools(pools);

    const status = await adapter.status?.();
    
    expect(status?.ok).toBe(true);
    expect(status?.message).toContain("Filesystem adapter");
    expect(status?.details?.pools).toBe(2);
  });
});
