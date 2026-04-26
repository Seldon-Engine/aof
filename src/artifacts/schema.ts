import { z } from "zod";

export const artifactArchiveManifestSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  project: z.string().min(1),
  title: z.string().min(1),
  source_path: z.string().min(1),
  archive_path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  file_count: z.number().int().nonnegative(),
  original_bytes: z.number().int().nonnegative(),
  archive_bytes: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  tags: z.array(z.string()),
  notes: z.string().optional(),
  destructive_prune_performed: z.boolean(),
  trash_path: z.string().optional(),
});

export type ArtifactArchiveManifest = z.infer<typeof artifactArchiveManifestSchema>;

export const artifactArchiveIndexRowSchema = z.object({
  id: z.string().min(1),
  schema_version: z.literal(1),
  project: z.string().min(1),
  title: z.string().min(1),
  source_path: z.string().min(1),
  archive_path: z.string().min(1),
  manifest_path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  file_count: z.number().int().nonnegative(),
  original_bytes: z.number().int().nonnegative(),
  archive_bytes: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  tags_json: z.string(),
  notes: z.string().nullable().optional(),
  destructive_prune_performed: z.union([z.literal(0), z.literal(1)]),
  trash_path: z.string().nullable().optional(),
});

export type ArtifactArchiveIndexRow = z.infer<typeof artifactArchiveIndexRowSchema>;

export type ArtifactArchiveRecord = Omit<ArtifactArchiveIndexRow, "tags_json" | "destructive_prune_performed"> & {
  tags: string[];
  destructive_prune_performed: boolean;
};

export const archiveArtifactOptionsSchema = z.object({
  sourceDir: z.string().min(1),
  project: z.string().min(1).default("default"),
  title: z.string().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  pruneOriginalToTrash: z.boolean().default(false),
  archiveRoot: z.string().optional(),
  dbPath: z.string().optional(),
  trashRoot: z.string().optional(),
});

export type ArchiveArtifactOptions = z.input<typeof archiveArtifactOptionsSchema>;
export type NormalizedArchiveArtifactOptions = z.output<typeof archiveArtifactOptionsSchema>;

export const listArtifactOptionsSchema = z.object({
  limit: z.number().int().positive().max(500).default(20),
  archiveRoot: z.string().optional(),
  dbPath: z.string().optional(),
});

export type ListArtifactOptions = z.input<typeof listArtifactOptionsSchema>;

export const restoreArtifactOptionsSchema = z.object({
  archiveId: z.string().min(1),
  destParent: z.string().min(1),
  archiveRoot: z.string().optional(),
  dbPath: z.string().optional(),
});

export type RestoreArtifactOptions = z.input<typeof restoreArtifactOptionsSchema>;
