import type { SqliteDb } from "../types.js";

import type { OpenClawToolDefinition, ToolResult } from "../../openclaw/types.js";
import { parseTags } from "../store/tag-serialization.js";

type MemoryListParams = {
  pool?: string;
  tier?: string;
  tags?: string[];
  limit?: number;
};

type MemoryListToolOptions = {
  db: SqliteDb;
  defaultLimit?: number;
};

type MemoryListRow = {
  filePath: string;
  tier: string | null;
  pool: string | null;
  importance: number | null;
  tags: string | null;
  updatedAt: number | null;
  createdAt: number | null;
};

const buildResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeTags = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((tag) => typeof tag === "string" && tag.trim());
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return [];
};

const resolveLimit = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
};

const buildListQuery = (pool?: string, tier?: string): { sql: string; params: unknown[] } => {
  const filters: string[] = [];
  const params: unknown[] = [];

  if (pool) {
    filters.push("pool = ?");
    params.push(pool);
  }

  if (tier) {
    filters.push("tier = ?");
    params.push(tier);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  return {
    sql: `
      SELECT
        file_path as filePath,
        MAX(tier) as tier,
        MAX(pool) as pool,
        MAX(importance) as importance,
        MAX(tags) as tags,
        MAX(updated_at) as updatedAt,
        MIN(created_at) as createdAt
      FROM chunks
      ${whereClause}
      GROUP BY file_path
      ORDER BY updatedAt DESC
      LIMIT ?
    `,
    params,
  };
};

const matchesTags = (rowTags: string[] | null, tags: string[]): boolean => {
  if (tags.length === 0) {
    return true;
  }

  if (!rowTags || rowTags.length === 0) {
    return false;
  }

  return tags.every((tag) => rowTags.includes(tag));
};

const formatEntry = (row: MemoryListRow, tags: string[] | null, index: number): string => {
  const details: string[] = [];

  if (row.tier) details.push(`tier: ${row.tier}`);
  if (row.pool) details.push(`pool: ${row.pool}`);
  if (typeof row.importance === "number") details.push(`importance: ${row.importance}`);
  if (tags && tags.length > 0) details.push(`tags: ${tags.join(", ")}`);

  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `${index + 1}. ${row.filePath}${suffix}`;
};

export const createMemoryListTool = (
  options: MemoryListToolOptions,
): OpenClawToolDefinition => {
  return {
    name: "memory_list",
    description: "List memory files with optional metadata filters.",
    parameters: {
      type: "object",
      properties: {
        pool: {
          type: "string",
          description: "Optional pool filter",
        },
        tier: {
          type: "string",
          description: "Optional tier filter",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags filter",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return",
        },
      },
    },
    execute: (_id: string, params: Record<string, unknown>) => {
      const pool = normalizeString(params.pool);
      const tier = normalizeString(params.tier);
      const tags = normalizeTags(params.tags);
      const limit = resolveLimit(params.limit, options.defaultLimit ?? 50);

      const query = buildListQuery(pool, tier);
      const rows = options.db
        .prepare(query.sql)
        .all(...query.params, limit) as MemoryListRow[];

      const filtered = rows
        .map((row) => ({
          row,
          parsedTags: parseTags(row.tags),
        }))
        .filter((entry) => matchesTags(entry.parsedTags, tags));

      if (filtered.length === 0) {
        return buildResult("No memories found.");
      }

      const lines = filtered.map((entry, index) =>
        formatEntry(entry.row, entry.parsedTags, index),
      );

      return buildResult(lines.join("\n"));
    },
  };
};
