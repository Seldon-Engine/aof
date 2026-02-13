/**
 * Filesystem Adapter — fallback adapter (no semantic recall).
 * 
 * This adapter provides basic keyword search or returns empty results.
 * It ensures AOF runs without any external dependencies.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MemoryRetrievalAdapter,
  MemoryPoolDefinition,
  MemoryQuery,
  MemoryResult,
  MemoryAdapterStatus,
} from "../adapter.js";

export class FilesystemAdapter implements MemoryRetrievalAdapter {
  readonly id = "filesystem";
  readonly capabilities = {
    semantic: false,
    keyword: true,
  };

  private pools: MemoryPoolDefinition[] = [];
  private vaultRoot?: string;

  async init(opts: { dataDir: string; vaultRoot?: string }): Promise<void> {
    this.vaultRoot = opts.vaultRoot;
  }

  async registerPools(pools: MemoryPoolDefinition[]): Promise<void> {
    this.pools = pools;
  }

  async indexPaths(_paths: string[]): Promise<void> {
    // No-op: filesystem adapter does not maintain an index
  }

  /**
   * Best-effort keyword search across registered pools.
   * Returns empty with warning for now (can be enhanced with grep-like search).
   */
  async recall(query: MemoryQuery): Promise<MemoryResult[]> {
    // Filter pools by agent access and tiers
    const allowedTiers = query.tiers ?? ["hot", "warm"];
    const allowedPoolIds = query.poolIds
      ? new Set(query.poolIds)
      : undefined;

    const eligiblePools = this.pools.filter((pool) => {
      if (allowedPoolIds && !allowedPoolIds.has(pool.id)) return false;
      if (!allowedTiers.includes(pool.tier)) return false;
      if (pool.agents && !pool.agents.includes(query.agentId)) return false;
      return true;
    });

    if (eligiblePools.length === 0) {
      return [];
    }

    // For now, return empty (future: implement simple keyword search)
    // This prevents runtime errors while maintaining clear behavior
    return [];
  }

  async status(): Promise<MemoryAdapterStatus> {
    return {
      ok: true,
      message: "Filesystem adapter active (no semantic recall)",
      details: { pools: this.pools.length },
    };
  }
}

/**
 * Create and return a filesystem adapter instance.
 */
export function createFilesystemAdapter(): MemoryRetrievalAdapter {
  return new FilesystemAdapter();
}
