import { readFile, writeFile } from "node:fs/promises";

import type { SqliteDb } from "../types.js";

import type { OpenClawToolDefinition, ToolResult } from "../../openclaw/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { chunkMarkdown } from "../chunking/chunker.js";
import { computeFileHash, hasFileChanged } from "../chunking/hash.js";
import type { FtsStore } from "../store/fts-store.js";
import type { VectorStore } from "../store/vector-store.js";
import { indexMemoryChunks } from "./indexing.js";
import {
  buildOutputContent,
  normalizeContent,
  parseContent,
  resolveMetadata,
} from "./metadata.js";

type MemoryUpdateParams = {
  path: string;
  content?: string;
  tier?: string;
  tags?: string[];
  importance?: number;
};

type MemoryUpdateToolOptions = {
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  ftsStore: FtsStore;
  db: SqliteDb;
};

const buildResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const resolveFileContent = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

export const createMemoryUpdateTool = (
  options: MemoryUpdateToolOptions,
): OpenClawToolDefinition => {
  return {
    name: "memory_update",
    description: "Update a memory file, re-chunk it, and re-index embeddings.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to update (required)",
        },
        content: {
          type: "string",
          description: "Updated markdown content (optional)",
        },
        tier: {
          type: "string",
          description: "Optional tier override",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tag override",
        },
        importance: {
          type: "number",
          description: "Optional importance score",
        },
      },
      required: ["path"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const pathValue = params.path;
      if (typeof pathValue !== "string" || !pathValue.trim()) {
        return buildResult("Path is required.");
      }

      const filePath = pathValue.trim();
      const existingContent = await resolveFileContent(filePath);

      if (!existingContent) {
        return buildResult(`File not found: ${filePath}`);
      }

      const parsedParams = params as MemoryUpdateParams;
      const parsed = parseContent(existingContent);
      const updatedBody = normalizeContent(parsedParams.content) ?? parsed.content;
      const metadata = resolveMetadata(
        parsedParams,
        parsed.data as Record<string, unknown>,
      );

      const output = buildOutputContent(
        updatedBody,
        parsed.data as Record<string, unknown>,
        metadata,
      );
      const chunks = chunkMarkdown(updatedBody);
      const hash = computeFileHash(output.body);

      if (!hasFileChanged(options.db, filePath, hash)) {
        return buildResult(`No changes detected for ${filePath}.`);
      }

      await writeFile(filePath, output.body, "utf-8");
      await indexMemoryChunks(options, filePath, chunks, metadata, hash);

      return buildResult(`Updated memory at ${filePath} (chunks: ${chunks.length}).`);
    },
  };
};
