/**
 * Migration 005: Path reconciliation.
 *
 * Fixes split-brain installs where some components used ~/.openclaw/aof (legacy)
 * and others used ~/.aof (canonical). Reconciles data into ~/.aof.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { access, stat, cp, mkdir, writeFile } from "node:fs/promises";
import type { Migration, MigrationContext } from "../migrations.js";

const LEGACY_DIR = join(homedir(), ".openclaw", "aof");
const BREADCRUMB = ".migrated-to-dot-aof";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function newerMtime(a: string, b: string): Promise<"a" | "b" | "same"> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    if (sa.mtimeMs > sb.mtimeMs) return "a";
    if (sb.mtimeMs > sa.mtimeMs) return "b";
    return "same";
  } catch { return "same"; }
}

function say(msg: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

export const migration005: Migration = {
  id: "005-path-reconciliation",
  version: "1.10.0",
  description: "Reconcile split-brain installs (legacy ~/.openclaw/aof → ~/.aof)",

  up: async (ctx: MigrationContext): Promise<void> => {
    const canonical = ctx.aofRoot;

    // Skip if canonical IS the legacy dir (edge case: someone installed to legacy path)
    if (canonical === LEGACY_DIR) {
      say("005 skipped (install dir is legacy path)");
      return;
    }

    // Skip if legacy dir doesn't exist
    if (!(await exists(LEGACY_DIR))) {
      say("005 skipped (no legacy directory)");
      return;
    }

    // Skip if already reconciled
    if (await exists(join(LEGACY_DIR, BREADCRUMB))) {
      say("005 skipped (already reconciled)");
      return;
    }

    say("005 reconciling legacy ~/.openclaw/aof → ~/.aof ...");

    // Directories to reconcile
    const dirs = ["org", "tasks", "events", "memory", "data", "state"];
    let reconciled = 0;

    for (const dir of dirs) {
      const legacyPath = join(LEGACY_DIR, dir);
      const canonicalPath = join(canonical, dir);

      if (!(await exists(legacyPath))) continue;

      if (!(await exists(canonicalPath))) {
        // Canonical missing — copy from legacy
        await mkdir(canonicalPath, { recursive: true });
        await cp(legacyPath, canonicalPath, { recursive: true });
        say(`Copied ${dir}/ from legacy to canonical`);
        reconciled++;
      } else {
        // Both exist — for org/org-chart.yaml, keep the newer one
        if (dir === "org") {
          const legacyChart = join(legacyPath, "org-chart.yaml");
          const canonicalChart = join(canonicalPath, "org-chart.yaml");
          if ((await exists(legacyChart)) && (await exists(canonicalChart))) {
            const newer = await newerMtime(legacyChart, canonicalChart);
            if (newer === "a") {
              await cp(legacyChart, canonicalChart);
              warn(`org-chart.yaml: legacy was newer — copied to canonical`);
              reconciled++;
            } else if (newer === "b") {
              say(`org-chart.yaml: canonical is newer — keeping`);
            } else {
              say(`org-chart.yaml: same mtime — keeping canonical`);
            }
          } else if ((await exists(legacyChart)) && !(await exists(canonicalChart))) {
            await cp(legacyChart, canonicalChart);
            say(`Copied org-chart.yaml from legacy`);
            reconciled++;
          }
        }
        // For other dirs, don't overwrite — canonical wins
      }
    }

    // Reconcile individual files
    const files = ["memory.db", "memory-hnsw.dat"];
    for (const file of files) {
      const legacyPath = join(LEGACY_DIR, file);
      const canonicalPath = join(canonical, file);

      if (!(await exists(legacyPath))) continue;

      if (!(await exists(canonicalPath))) {
        await cp(legacyPath, canonicalPath);
        say(`Copied ${file} from legacy`);
        reconciled++;
      } else {
        const newer = await newerMtime(legacyPath, canonicalPath);
        if (newer === "a") {
          await cp(legacyPath, canonicalPath);
          warn(`${file}: legacy was newer — copied to canonical`);
          reconciled++;
        }
      }
    }

    // Write breadcrumb
    await writeFile(
      join(LEGACY_DIR, BREADCRUMB),
      `Reconciled to ${canonical} at ${new Date().toISOString()}\n`,
      "utf-8",
    );

    if (reconciled > 0) {
      say(`005 reconciled ${reconciled} item(s) from legacy to canonical`);
    } else {
      say("005 completed (no items needed reconciliation)");
    }
  },
};
