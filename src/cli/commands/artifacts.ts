import type { Command } from "commander";
import { ArtifactArchiveService } from "../../artifacts/archive-service.js";
import { DEFAULT_ARTIFACT_ARCHIVE_ROOT } from "../../artifacts/paths.js";
import type { ArtifactArchiveRecord } from "../../artifacts/schema.js";

type ArchiveCliOptions = {
  project?: string;
  title?: string;
  tag?: string[];
  notes?: string;
  pruneOriginalToTrash?: boolean;
  archiveRoot?: string;
  dbPath?: string;
};

type ListCliOptions = {
  limit?: string;
  json?: boolean;
  archiveRoot?: string;
  dbPath?: string;
};

type RestoreCliOptions = {
  dest: string;
  archiveRoot?: string;
  dbPath?: string;
};

export function registerArtifactCommands(program: Command): void {
  const artifacts = program
    .command("artifacts")
    .description("Archive, list, and restore local artifact directories");

  artifacts
    .command("archive")
    .argument("<source-dir>", "artifact directory to archive")
    .option("--project <name>", "project name", "default")
    .option("--title <title>", "archive title")
    .option("--tag <tag>", "tag to attach (repeatable)", collectTags, [] as string[])
    .option("--notes <text>", "operator notes")
    .option("--prune-original-to-trash", "move source directory to Trash after successful archive/index write", false)
    .option("--archive-root <path>", "cold-storage archive root", DEFAULT_ARTIFACT_ARCHIVE_ROOT)
    .option("--db-path <path>", "SQLite index path override")
    .action(async (sourceDir: string, opts: ArchiveCliOptions) => {
      try {
        const result = await new ArtifactArchiveService().archive({
          sourceDir,
          project: opts.project,
          title: opts.title,
          tags: opts.tag ?? [],
          notes: opts.notes,
          pruneOriginalToTrash: opts.pruneOriginalToTrash ?? false,
          archiveRoot: opts.archiveRoot,
          dbPath: opts.dbPath,
        });
        console.log(JSON.stringify({ ...result.manifest, manifest_path: result.manifestPath }, null, 2));
      } catch (error) {
        failCommand(error);
      }
    });

  artifacts
    .command("list")
    .option("--limit <n>", "maximum archives to show", "20")
    .option("--json", "print JSON rows", false)
    .option("--archive-root <path>", "cold-storage archive root", DEFAULT_ARTIFACT_ARCHIVE_ROOT)
    .option("--db-path <path>", "SQLite index path override")
    .action(async (opts: ListCliOptions) => {
      try {
        const limit = Number.parseInt(opts.limit ?? "20", 10);
        const rows = await new ArtifactArchiveService().list({
          limit: Number.isNaN(limit) ? 20 : limit,
          archiveRoot: opts.archiveRoot,
          dbPath: opts.dbPath,
        });
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        printArchiveList(rows);
      } catch (error) {
        failCommand(error);
      }
    });

  artifacts
    .command("restore")
    .argument("<archive-id>", "archive id to restore")
    .requiredOption("--dest <destination-parent>", "destination parent directory")
    .option("--archive-root <path>", "cold-storage archive root", DEFAULT_ARTIFACT_ARCHIVE_ROOT)
    .option("--db-path <path>", "SQLite index path override")
    .action(async (archiveId: string, opts: RestoreCliOptions) => {
      try {
        const result = await new ArtifactArchiveService().restore({
          archiveId,
          destParent: opts.dest,
          archiveRoot: opts.archiveRoot,
          dbPath: opts.dbPath,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        failCommand(error);
      }
    });
}

function collectTags(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printArchiveList(rows: ArtifactArchiveRecord[]): void {
  if (rows.length === 0) {
    console.log("No artifact archives found. If this is a new install, no index has been created yet.");
    return;
  }

  for (const row of rows) {
    console.log(`${row.created_at} | ${row.project} | ${row.title}`);
    console.log(`  id: ${row.id}`);
    console.log(`  files: ${row.file_count} | original bytes: ${row.original_bytes} | archive bytes: ${row.archive_bytes}`);
    console.log(`  tags: ${row.tags.join(", ") || "—"}`);
    console.log(`  archive: ${row.archive_path}`);
    if (row.notes) console.log(`  notes: ${row.notes}`);
  }
}

function failCommand(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
