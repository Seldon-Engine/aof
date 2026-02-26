import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { OpenClawApi, OpenClawToolDefinition } from "../openclaw/types.js";
import type { SqliteDb } from "./types.js";
import { existsSync } from "node:fs";
import { initMemoryDb } from "./store/schema.js";
import { VectorStore } from "./store/vector-store.js";
import { HnswIndex } from "./store/hnsw-index.js";
import { FtsStore } from "./store/fts-store.js";
import { HybridSearchEngine } from "./store/hybrid-search.js";
import { createReranker } from "./store/reranker.js";
import type { RerankerConfig } from "./store/reranker.js";
import { OpenAIEmbeddingProvider } from "./embeddings/openai-provider.js";
import { createMemorySearchTool } from "./tools/search.js";
import { createMemoryStoreTool } from "./tools/store.js";
import { createMemoryUpdateTool } from "./tools/update.js";
import { createMemoryDeleteTool } from "./tools/delete.js";
import { createMemoryListTool } from "./tools/list.js";
import { memoryGetTool } from "./tools/get.js";
import { IndexSyncService } from "./tools/indexing.js";
import { getProjectMemoryStore, saveAllProjectMemory } from "./project-memory.js";

export { generateMemoryConfig, resolvePoolPath } from "./generator.js";
export { auditMemoryConfig, formatMemoryAuditReport } from "./audit.js";
export { getProjectMemoryStore, saveAllProjectMemory, clearProjectMemoryCache } from "./project-memory.js";
export type { ProjectMemoryStore } from "./project-memory.js";

// ─── Memory module registration (AOF-a39) ────────────────────────────────────

interface _EmbeddingConfig {
  provider?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
}

interface _MemoryModuleConfig {
  enabled?: boolean;
  embedding?: _EmbeddingConfig;
  indexPaths?: string[];
  scanIntervalMs?: number;
  dbPath?: string;
  poolPaths?: Record<string, string>;
  defaultPool?: string;
  defaultTier?: string;
  defaultLimit?: number;
  reranker?: RerankerConfig;
}

interface _PluginConfig {
  dataDir?: string;
  modules?: { memory?: { enabled?: boolean } };
  memory?: _MemoryModuleConfig;
}

function _expandPath(p: string): string {
  return p.replace(/^~(?=$|[/\\])/, homedir());
}

/** Ensure the memory_meta table exists for tracking rebuild metadata. */
function ensureMemoryMeta(db: SqliteDb): void {
  db.exec("CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)");
}

/** Rebuild the HNSW index from all embeddings stored in sqlite vec_chunks. */
export function rebuildHnswFromDb(db: SqliteDb, hnsw: HnswIndex): void {
  const rows = db
    .prepare("SELECT chunk_id, embedding FROM vec_chunks")
    .all() as Array<{ chunk_id: bigint; embedding: Buffer }>;

  const chunks = rows.map((row) => ({
    id: Number(row.chunk_id),
    embedding: Array.from(new Float32Array(row.embedding.buffer)),
  }));

  hnsw.rebuild(chunks);

  // Track last rebuild time in memory_meta
  ensureMemoryMeta(db);
  db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('last_rebuild_time', datetime('now'))").run();
}

/** Add `project` parameter to a tool's schema. */
function _addProjectParam(tool: OpenClawToolDefinition): OpenClawToolDefinition["parameters"] {
  return {
    type: tool.parameters?.type ?? "object",
    properties: {
      ...(tool.parameters?.properties ?? {}),
      project: {
        type: "string",
        description: "Project ID to scope this memory operation to. Omit for global memory.",
      },
    },
    required: tool.parameters?.required,
  };
}

export function registerMemoryModule(api: OpenClawApi): void {
  const raw = api.pluginConfig as _PluginConfig | undefined;
  const enabled = raw?.modules?.memory?.enabled ?? raw?.memory?.enabled ?? false;
  if (!enabled) return;

  const memoryCfg: _MemoryModuleConfig = raw?.memory ?? {};
  const embCfg = memoryCfg.embedding ?? { model: "nomic-embed-text" };
  const dimensions = embCfg.dimensions ?? 768;

  const rawDataDir = raw?.dataDir ?? "~/.openclaw/aof";
  const dataDir = _expandPath(rawDataDir);
  const dbPath = memoryCfg.dbPath ? _expandPath(memoryCfg.dbPath) : join(dataDir, "memory.db");

  const db = initMemoryDb(dbPath, dimensions);

  const hnswPath = dbPath.replace(/\.db$/, "-hnsw.dat");
  const hnsw = new HnswIndex(dimensions);
  ensureMemoryMeta(db);

  let needsRebuild = false;

  if (existsSync(hnswPath)) {
    try {
      hnsw.load(hnswPath);
    } catch {
      // Corrupt or incompatible index file
      console.warn("[AOF] HNSW index corrupt or incompatible. Rebuilding from SQLite...");
      needsRebuild = true;
    }
  } else {
    console.warn("[AOF] HNSW index missing. Rebuilding from SQLite...");
    needsRebuild = true;
  }

  // Parity check: compare HNSW count to SQLite count every startup
  if (!needsRebuild) {
    const hnswCount = hnsw.count;
    const sqliteCount = (db.prepare("SELECT COUNT(*) as c FROM vec_chunks").get() as { c: number }).c;
    if (hnswCount !== sqliteCount) {
      console.warn(
        `[AOF] HNSW-SQLite desync detected (HNSW: ${hnswCount}, SQLite: ${sqliteCount}). Rebuilding index...`,
      );
      needsRebuild = true;
    }
  }

  if (needsRebuild) {
    rebuildHnswFromDb(db, hnsw);
    // Persist the freshly rebuilt index to disk
    hnsw.save(hnswPath);
  }

  const vectorStore = new VectorStore(db, hnsw, hnswPath);
  const ftsStore = new FtsStore(db);
  const searchEngine = new HybridSearchEngine(vectorStore, ftsStore);

  const embeddingProvider = new OpenAIEmbeddingProvider({
    model: embCfg.model,
    baseUrl: embCfg.baseUrl,
    apiKey: embCfg.apiKey ?? process.env.OPENAI_API_KEY,
    dimensions,
  });

  const poolPaths: Record<string, string> =
    memoryCfg.poolPaths ?? { core: join(dataDir, "memory") };
  const defaultPool = memoryCfg.defaultPool ?? "core";
  const defaultTier = memoryCfg.defaultTier ?? "hot";
  const defaultLimit = memoryCfg.defaultLimit ?? 20;

  const reranker = memoryCfg.reranker
    ? createReranker(memoryCfg.reranker)
    : null;
  const topKBeforeRerank = memoryCfg.reranker?.topKBeforeRerank;

  // ─── Project-aware tool helpers ────────────────────────────────────────────
  // Each memory tool accepts an optional `project` param. When provided, the
  // tool resolves the project-specific memory store and delegates to a
  // project-scoped tool instance. When absent, the global store is used.

  const vaultRoot = resolve(dataDir, "..");

  /** Resolve project root from a project ID. */
  const getProjectRoot = (projectId: string): string =>
    join(vaultRoot, "Projects", projectId);

  // ─── memory_search (project-aware) ──────────────────────────────────────────
  const globalSearchTool = createMemorySearchTool({
    embeddingProvider,
    searchEngine,
    ...(reranker ? { reranker, topKBeforeRerank } : {}),
  });

  api.registerTool({
    ...globalSearchTool,
    parameters: _addProjectParam(globalSearchTool),
    execute: async (id: string, params: Record<string, unknown>) => {
      const projectId = params.project as string | undefined;
      if (projectId) {
        const projectMemory = getProjectMemoryStore(getProjectRoot(projectId), dimensions);
        const projectSearchTool = createMemorySearchTool({
          embeddingProvider,
          searchEngine: projectMemory.searchEngine,
          ...(reranker ? { reranker, topKBeforeRerank } : {}),
        });
        return projectSearchTool.execute(id, params);
      }
      return globalSearchTool.execute(id, params);
    },
  });

  // ─── memory_store (project-aware) ───────────────────────────────────────────
  const globalStoreTool = createMemoryStoreTool({ db, embeddingProvider, vectorStore, ftsStore, poolPaths, defaultPool, defaultTier });

  api.registerTool({
    ...globalStoreTool,
    parameters: _addProjectParam(globalStoreTool),
    execute: async (id: string, params: Record<string, unknown>) => {
      const projectId = params.project as string | undefined;
      if (projectId) {
        const pRoot = getProjectRoot(projectId);
        const projectMemory = getProjectMemoryStore(pRoot, dimensions);
        const projectPoolPaths: Record<string, string> = { core: join(pRoot, "memory") };
        const projectTool = createMemoryStoreTool({
          db: projectMemory.db,
          embeddingProvider,
          vectorStore: projectMemory.vectorStore,
          ftsStore: projectMemory.ftsStore,
          poolPaths: projectPoolPaths,
          defaultPool,
          defaultTier,
        });
        return projectTool.execute(id, params);
      }
      return globalStoreTool.execute(id, params);
    },
  });

  // ─── memory_update (project-aware) ──────────────────────────────────────────
  const globalUpdateTool = createMemoryUpdateTool({ db, embeddingProvider, vectorStore, ftsStore });

  api.registerTool({
    ...globalUpdateTool,
    parameters: _addProjectParam(globalUpdateTool),
    execute: async (id: string, params: Record<string, unknown>) => {
      const projectId = params.project as string | undefined;
      if (projectId) {
        const projectMemory = getProjectMemoryStore(getProjectRoot(projectId), dimensions);
        const projectTool = createMemoryUpdateTool({
          db: projectMemory.db,
          embeddingProvider,
          vectorStore: projectMemory.vectorStore,
          ftsStore: projectMemory.ftsStore,
        });
        return projectTool.execute(id, params);
      }
      return globalUpdateTool.execute(id, params);
    },
  });

  // ─── memory_delete (project-aware) ──────────────────────────────────────────
  const globalDeleteTool = createMemoryDeleteTool({ db, vectorStore, ftsStore });

  api.registerTool({
    ...globalDeleteTool,
    parameters: _addProjectParam(globalDeleteTool),
    execute: async (id: string, params: Record<string, unknown>) => {
      const projectId = params.project as string | undefined;
      if (projectId) {
        const projectMemory = getProjectMemoryStore(getProjectRoot(projectId), dimensions);
        const projectTool = createMemoryDeleteTool({
          db: projectMemory.db,
          vectorStore: projectMemory.vectorStore,
          ftsStore: projectMemory.ftsStore,
        });
        return projectTool.execute(id, params);
      }
      return globalDeleteTool.execute(id, params);
    },
  });

  // ─── memory_list (project-aware) ────────────────────────────────────────────
  const globalListTool = createMemoryListTool({ db, defaultLimit });

  api.registerTool({
    ...globalListTool,
    parameters: _addProjectParam(globalListTool),
    execute: (id: string, params: Record<string, unknown>) => {
      const projectId = params.project as string | undefined;
      if (projectId) {
        const projectMemory = getProjectMemoryStore(getProjectRoot(projectId), dimensions);
        const projectTool = createMemoryListTool({ db: projectMemory.db, defaultLimit });
        return projectTool.execute(id, params);
      }
      return globalListTool.execute(id, params);
    },
  });

  // ─── memory_get (unchanged -- operates by chunk ID across global DB) ────────
  api.registerTool(memoryGetTool);

  const syncService = new IndexSyncService({
    db,
    embeddingProvider,
    vectorStore,
    ftsStore,
    indexPaths: memoryCfg.indexPaths ?? [],
    scanIntervalMs: memoryCfg.scanIntervalMs,
  });

  api.registerService({
    id: "memory-index-sync",
    start: async () => {
      await syncService.runOnce();
      syncService.start();
    },
    stop: () => {
      syncService.stop();
      try {
        hnsw.save(hnswPath);
      } catch {
        // Non-critical: index will be rebuilt from sqlite on next start
      }
      saveAllProjectMemory();
    },
  });
}

export { ColdTier } from "./cold-tier.js";
export { WarmAggregator } from "./warm-aggregation.js";
export { HotPromotion } from "./hot-promotion.js";
export type {
  MemoryConfig,
  MemoryConfigOptions,
  MemoryConfigResult,
  AgentMemoryExplanation,
  PoolMatch,
} from "./generator.js";
export type { OpenClawConfig, MemoryAuditEntry, MemoryAuditReport } from "./audit.js";
export type { ColdTierOptions, IncidentReport } from "./cold-tier.js";
export type {
  AggregationRule,
  AggregationOptions,
  AggregationResult,
} from "./warm-aggregation.js";
export type { PromotionOptions, PromotionResult } from "./hot-promotion.js";
