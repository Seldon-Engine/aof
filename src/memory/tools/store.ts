import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { SqliteDb } from "../types.js";

import type { OpenClawToolDefinition, ToolResult } from "../../openclaw/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { chunkMarkdown } from "../chunking/chunker.js";
import { computeFileHash } from "../chunking/hash.js";
import type { FtsStore } from "../store/fts-store.js";
import type { VectorStore } from "../store/vector-store.js";
import { indexMemoryChunks } from "./indexing.js";
import {
  buildOutputContent,
  normalizeContent,
  normalizeString,
  parseContent,
  resolveMetadata,
} from "./metadata.js";

type MemoryStoreParams = {
  content: string;
  path?: string;
  pool?: string;
  tier?: string;
  tags?: string[];
  importance?: number;
};

type MemoryStoreToolOptions = {
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  ftsStore: FtsStore;
  db: SqliteDb;
  poolPaths: Record<string, string>;
  defaultPool?: string;
  defaultTier?: string;
};

// metadata helpers imported from metadata.ts
const buildResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

// helpers moved to metadata.ts

const resolvePoolPath = (
  pool: string | undefined,
  poolPaths: Record<string, string>,
): string | undefined => {
  if (!pool) {
    return undefined;
  }

  return poolPaths[pool];
};

const ensureDirectory = async (filePath: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
};

const generateFileName = (): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `memory-${timestamp}-${randomUUID()}.md`;
};

const resolveFilePath = (
  params: MemoryStoreParams,
  poolPath: string | undefined,
): string | null => {
  const requested = normalizeString(params.path);
  if (requested) {
    if (path.isAbsolute(requested)) {
      return requested;
    }

    if (!poolPath) {
      return null;
    }

    return path.join(poolPath, requested);
  }

  if (!poolPath) {
    return null;
  }

  return path.join(poolPath, generateFileName());
};

// indexing handled in indexing.ts

export const createMemoryStoreTool = (
  options: MemoryStoreToolOptions,
): OpenClawToolDefinition => {
  return {
    name: "memory_store",
    description: "Store a memory entry, chunk it, embed it, and index it.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Markdown content to store (required)",
        },
        path: {
          type: "string",
          description: "Optional file path to write",
        },
        pool: {
          type: "string",
          description: "Optional pool identifier",
        },
        tier: {
          type: "string",
          description: "Optional tier (hot|warm|cold)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags",
        },
        importance: {
          type: "number",
          description: "Optional importance score",
        },
      },
      required: ["content"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const content = normalizeContent(params.content);
      if (!content || !content.trim()) {
        return buildResult("Content is required.");
      }

      const parsedParams = params as MemoryStoreParams;
      const parsed = parseContent(content);
      const metadata = resolveMetadata(
        parsedParams,
        parsed.data as Record<string, unknown>,
        { defaultTier: options.defaultTier, defaultPool: options.defaultPool },
      );
      const poolPath = resolvePoolPath(metadata.pool, options.poolPaths);
      const filePath = resolveFilePath(parsedParams, poolPath);

      if (!filePath) {
        return buildResult("Pool path is required to resolve the memory file path.");
      }

      const output = buildOutputContent(
        parsed.content,
        parsed.data as Record<string, unknown>,
        metadata,
      );
      const chunks = chunkMarkdown(parsed.content);
      const hash = computeFileHash(output.body);

      await ensureDirectory(filePath);
      await writeFile(filePath, output.body, "utf-8");

      await indexMemoryChunks(options, filePath, chunks, metadata, hash);

      return buildResult(`Stored memory at ${filePath} (chunks: ${chunks.length}).`);
    },
  };
};
