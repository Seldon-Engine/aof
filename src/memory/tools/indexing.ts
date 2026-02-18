import type Database from "better-sqlite3";

import type { EmbeddingProvider } from "../embeddings/provider.js";
import type { Chunk } from "../chunking/chunker.js";
import { updateFileRecord } from "../chunking/hash.js";
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
