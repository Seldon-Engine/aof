import matter from "gray-matter";

export type NormalizedMetadata = {
  pool?: string;
  tier?: string;
  tags?: string[];
  importance?: number;
};

export const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export const normalizeContent = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const normalizeTags = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const tags = value.filter((tag) => typeof tag === "string" && tag.trim());
    return tags.length > 0 ? tags.map((tag) => tag.trim()) : undefined;
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return undefined;
};

export const normalizeNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
};

export const resolveMetadata = (
  params: {
    pool?: string;
    tier?: string;
    tags?: string[];
    importance?: number;
  },
  frontmatter: Record<string, unknown>,
  defaults?: { defaultTier?: string; defaultPool?: string },
): NormalizedMetadata => {
  const tier =
    normalizeString(params.tier) ??
    normalizeString(frontmatter.tier) ??
    defaults?.defaultTier;
  const pool =
    normalizeString(params.pool) ??
    normalizeString(frontmatter.pool) ??
    defaults?.defaultPool;
  const tags = normalizeTags(params.tags) ?? normalizeTags(frontmatter.tags);
  const importance =
    normalizeNumber(params.importance) ?? normalizeNumber(frontmatter.importance);

  return { tier, pool, tags, importance };
};

export const buildOutputContent = (
  bodyContent: string,
  frontmatter: Record<string, unknown>,
  metadata: NormalizedMetadata,
): { body: string; frontmatter: Record<string, unknown> } => {
  const merged = { ...frontmatter } as Record<string, unknown>;

  if (metadata.tier) merged.tier = metadata.tier;
  if (metadata.pool) merged.pool = metadata.pool;
  if (metadata.tags) merged.tags = metadata.tags;
  if (metadata.importance !== undefined) merged.importance = metadata.importance;

  return {
    body: matter.stringify(bodyContent, merged),
    frontmatter: merged,
  };
};

export const parseContent = (content: string) => matter(content);
