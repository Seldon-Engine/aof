/**
 * Memory Retrieval Adapter — pluggable interface for recall backends.
 * 
 * AOF owns memory structure (tiers, pools, enrollment). Adapters own retrieval.
 * Must work with no adapter installed (filesystem-only fallback).
 */

/** Memory pool definition (authoritative from AOF). */
export interface MemoryPoolDefinition {
  id: string;
  tier: "hot" | "warm" | "cold";
  path: string; // absolute or vault-root-resolved
  roles?: string[];
  agents?: string[];
}

/** Query for memory recall. */
export interface MemoryQuery {
  agentId: string;
  query: string;
  limit?: number; // default 10
  poolIds?: string[]; // optional allowlist
  tiers?: Array<"hot" | "warm" | "cold">; // default: hot+warm
  filters?: Record<string, string | string[]>;
}

/** Single recall result. */
export interface MemoryResult {
  id: string; // backend-specific id
  uri: string; // file path or logical id
  score?: number; // relevance score (0-1)
  snippet?: string; // excerpt for inline context
  content?: string; // optional full content
  metadata?: Record<string, unknown>;
}

/** Adapter health/diagnostics. */
export interface MemoryAdapterStatus {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Memory Retrieval Adapter interface (capability-driven).
 * 
 * Lifecycle:
 * 1. init() — setup (once at startup)
 * 2. registerPools() — sync AOF pool definitions
 * 3. indexPaths() — refresh specific paths (optional)
 * 4. recall() — search and return results
 * 5. status() — health check (optional)
 */
export interface MemoryRetrievalAdapter {
  /** Stable adapter id (e.g., "filesystem", "lancedb"). */
  readonly id: string;

  /** Supported recall modes. */
  readonly capabilities: {
    semantic: boolean; // vector similarity
    keyword: boolean; // keyword/grep-like
    graph?: boolean; // knowledge graph (optional)
  };

  /**
   * Initialize adapter. Called once at startup.
   * @param opts - dataDir: AOF runtime data dir; vaultRoot: vault path
   */
  init?(opts: { dataDir: string; vaultRoot?: string }): Promise<void>;

  /**
   * Register or update authoritative pools/paths from AOF.
   */
  registerPools(pools: MemoryPoolDefinition[]): Promise<void>;

  /**
   * Index or refresh specific paths. No-op for pull-based indexers.
   */
  indexPaths(paths: string[]): Promise<void>;

  /**
   * Recall relevant content by query and scope.
   */
  recall(query: MemoryQuery): Promise<MemoryResult[]>;

  /**
   * Optional health/diagnostics.
   */
  status?(): Promise<MemoryAdapterStatus>;
}
