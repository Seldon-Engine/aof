import type Database from "better-sqlite3";

import type { EmbeddingProvider } from "../embeddings/provider.js";
import { chunkMarkdown } from "../chunking/chunker.js";
import type { Chunk } from "../chunking/chunker.js";
import { updateFileRecord, computeFileHash, hasFileChanged } from "../chunking/hash.js";
import type { FtsStore } from "../store/fts-store.js";
import type { VectorStore } from "../store/vector-store.js";

type MemoryIndexOptions = {
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  ftsStore: FtsStore;
  db: Database;
};

export type MemoryIndexMetadata = {
  pool?: string;
  tier?: string;
  tags?: string[];
  importance?: number;
};

export const indexMemoryChunks = async (
  options: MemoryIndexOptions,
  filePath: string,
  chunks: Chunk[],
  metadata: MemoryIndexMetadata,
  hash: string,
): Promise<void> => {
  options.vectorStore.deleteChunksByFile(filePath);
  options.ftsStore.deleteChunksByFile(filePath);

  const embeddings = await options.embeddingProvider.embed(
    chunks.map((chunk) => chunk.content),
  );

  if (embeddings.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch (expected ${chunks.length}, got ${embeddings.length})`,
    );
  }

  chunks.forEach((chunk, index) => {
    const chunkId = options.vectorStore.insertChunk({
      filePath,
      chunkIndex: index,
      content: chunk.content,
      embedding: embeddings[index] ?? [],
      tier: metadata.tier,
      pool: metadata.pool,
      importance: metadata.importance ?? null,
      tags: metadata.tags ?? null,
    });

    options.ftsStore.insertChunk({
      chunkId,
      content: chunk.content,
      filePath,
      tags: metadata.tags ?? null,
    });
  });

  updateFileRecord(
    options.db,
    filePath,
    hash,
    chunks.length,
    metadata.tier,
    metadata.pool,
  );
};


// ─── IndexSyncService ────────────────────────────────────────────────────────

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface IndexSyncOptions {
  db: Database;
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  ftsStore: FtsStore;
  indexPaths: string[];
  scanIntervalMs?: number;
}

export interface SyncResult {
  scanned: number;
  indexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

function expandSyncPath(p: string): string {
  return p.replace(/^~(?=$|[/\\])/, homedir());
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

function extractFrontmatterMetadata(content: string): MemoryIndexMetadata {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = match[1]!;
  const get = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1]!.trim() : undefined;
  };
  const importanceRaw = get("importance");
  return {
    tier: get("tier"),
    pool: get("pool"),
    importance: importanceRaw !== undefined ? Number(importanceRaw) : undefined,
  };
}

const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1000;

export class IndexSyncService {
  private readonly opts: Required<IndexSyncOptions>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(opts: IndexSyncOptions) {
    this.opts = {
      ...opts,
      scanIntervalMs: opts.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  async runOnce(): Promise<SyncResult> {
    const startMs = Date.now();
    let scanned = 0;
    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    for (const rawPath of this.opts.indexPaths) {
      const dir = resolve(expandSyncPath(rawPath));
      let files: string[];
      try {
        files = await collectMarkdownFiles(dir);
      } catch {
        continue;
      }
      for (const filePath of files) {
        scanned++;
        try {
          const content = await readFile(filePath, "utf-8");
          const hash = computeFileHash(content);
          if (!hasFileChanged(this.opts.db, filePath, hash)) {
            skipped++;
            continue;
          }
          const chunks = chunkMarkdown(content);
          if (chunks.length === 0) {
            skipped++;
            continue;
          }
          const metadata = extractFrontmatterMetadata(content);
          await indexMemoryChunks(
            {
              db: this.opts.db,
              embeddingProvider: this.opts.embeddingProvider,
              vectorStore: this.opts.vectorStore,
              ftsStore: this.opts.ftsStore,
            },
            filePath,
            chunks,
            metadata,
            hash,
          );
          indexed++;
        } catch {
          errors++;
        }
      }
    }

    return { scanned, indexed, skipped, errors, durationMs: Date.now() - startMs };
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch {
        // don't let scan errors kill the service
      }
      this.scheduleNext();
    }, this.opts.scanIntervalMs);
  }
}
