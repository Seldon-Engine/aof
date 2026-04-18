/**
 * Migration 008: Strip `project: data` from task frontmatter (BUG-044).
 *
 * Before v1.15.1, `FilesystemTaskStore` defaulted `projectId` to
 * `basename(projectRoot)`. For the unscoped base store at `~/.aof/data/`
 * this stamped `project: data` into every task's frontmatter. The
 * dispatcher then called `loadProjectManifest(store, "data")` on every
 * poll, which probed a non-existent `~/.aof/data/project.yaml` and
 * logged ENOENT.
 *
 * v1.15.1 fixes the store (no basename fallback, `project` field
 * omitted when unscoped); this migration cleans up already-written
 * tasks on existing installs.
 *
 * Scope: only tasks living DIRECTLY under `<aofRoot>/tasks/<status>/`
 * — i.e. the unscoped root. Tasks in project subdirectories
 * (`<aofRoot>/projects/<id>/tasks/<status>/`) are intentionally left
 * alone: there, a non-null `project` field is valid, and any
 * mismatch is a separate class of issue surfaced by `aof lint`.
 *
 * Strategy:
 *   - Scan each of the 8 status directories under `<aofRoot>/tasks/`.
 *   - For every `.md` file, read + parse the YAML frontmatter.
 *   - If `project === "data"` exactly, remove the key and rewrite.
 *   - Anything else (valid project-scoped tasks, missing frontmatter,
 *     hand-edited files) is left untouched.
 *
 * Idempotency: re-running on a clean install is a no-op — no task has
 * `project: data`, so nothing to strip. This lets `aof setup --upgrade`
 * be safely re-run.
 *
 * Version: 1.15.1 — pairs with the patch release that lands the store
 * fix.
 *
 * Source pattern: migration 007 (skeleton) + migration 006 (filesystem
 * walk + idempotent check).
 */

import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Migration, MigrationContext } from "../migrations.js";

const STATUS_DIRS = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
  "cancelled",
  "deadletter",
] as const;

const FRONTMATTER_FENCE = "---";

/** The exact spurious value the pre-v1.15.1 store stamped into the base tasks. */
const BOGUS_PROJECT_ID = "data";

function say(msg: string): void {
  console.log(`  \x1b[32m\u2713\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

/**
 * Strip `project: data` from a single task file's frontmatter.
 * Returns true iff the file was modified.
 *
 * Matches any other `project:` value (including legitimate project
 * IDs from mis-migrated installs) is deliberately NOT done here —
 * only the exact "data" sentinel is stripped to minimize the blast
 * radius. Other mismatches are surfaced by `aof lint`.
 */
async function stripBogusProjectFromFile(filePath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return false;
  }

  const lines = raw.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return false;

  const endIdx = lines.indexOf(FRONTMATTER_FENCE, 1);
  if (endIdx === -1) return false;

  const yamlBlock = lines.slice(1, endIdx).join("\n");
  const bodyBlock = lines.slice(endIdx + 1).join("\n");

  let parsed: Record<string, unknown>;
  try {
    const result = parseYaml(yamlBlock);
    if (!result || typeof result !== "object") return false;
    parsed = result as Record<string, unknown>;
  } catch {
    return false;
  }

  if (parsed.project !== BOGUS_PROJECT_ID) return false;

  // Remove the bogus project key and re-serialize. We preserve key
  // order by deleting in place rather than reconstructing; the `yaml`
  // library's stringify emits keys in the same order for the remaining
  // object.
  delete parsed.project;

  const newYaml = stringifyYaml(parsed, { lineWidth: 120 });
  const rebuilt = `${FRONTMATTER_FENCE}\n${newYaml}${FRONTMATTER_FENCE}\n${bodyBlock}`;

  await writeFileAtomic(filePath, rebuilt);
  return true;
}

export const migration008: Migration = {
  id: "008-strip-bogus-project-data",
  version: "1.15.1",
  description: "BUG-044: strip spurious `project: data` from unscoped-store task frontmatter",

  up: async (ctx: MigrationContext): Promise<void> => {
    const tasksDir = join(ctx.aofRoot, "tasks");

    let scanned = 0;
    let fixed = 0;

    for (const status of STATUS_DIRS) {
      const dir = join(tasksDir, status);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue; // Directory missing — fine, skip.
      }

      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = join(dir, entry);
        scanned++;
        try {
          if (await stripBogusProjectFromFile(filePath)) {
            fixed++;
          }
        } catch (err) {
          warn(`008: failed to rewrite ${filePath} (${String(err)}) — left in place`);
        }
      }
    }

    if (fixed === 0) {
      say(`008-strip-bogus-project-data skipped (scanned ${scanned} task(s), none with bogus project)`);
    } else {
      say(`008-strip-bogus-project-data stripped \`project: data\` from ${fixed}/${scanned} task(s)`);
    }
  },
};
