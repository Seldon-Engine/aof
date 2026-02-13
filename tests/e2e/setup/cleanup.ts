/**
 * Cleanup and artifact preservation for E2E tests.
 * 
 * Provides:
 * - Pre-test cleanup
 * - Post-test cleanup
 * - Failure artifact preservation
 */

import { mkdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface PreserveOptions {
  testName: string;
  dataDir: string;
  stateDir: string;
}

/**
 * Preserve test artifacts on failure.
 * 
 * Copies AOF data and OpenClaw state to tests/e2e/failures/<test-name>-<timestamp>/
 * for CI artifact upload and local debugging.
 */
export async function preserveFailureArtifacts(
  options: PreserveOptions
): Promise<string> {
  const { testName, dataDir, stateDir } = options;
  
  // Create timestamped failure directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sanitizedTestName = testName
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
  const failureDir = join(
    process.cwd(),
    "tests/e2e/failures",
    `${sanitizedTestName}-${timestamp}`
  );

  await mkdir(failureDir, { recursive: true });

  // Copy AOF data directory (if exists)
  if (existsSync(dataDir)) {
    try {
      await cp(dataDir, join(failureDir, "aof-data"), { recursive: true });
    } catch (error) {
      console.error(`[Artifact Preservation] Failed to copy AOF data:`, error);
    }
  }

  // Copy OpenClaw state directory (if exists)
  if (existsSync(stateDir)) {
    try {
      await cp(stateDir, join(failureDir, "openclaw-state"), { recursive: true });
    } catch (error) {
      console.error(`[Artifact Preservation] Failed to copy OpenClaw state:`, error);
    }
  }

  // Write metadata file
  const metadata = {
    testName,
    timestamp: new Date().toISOString(),
    dataDir,
    stateDir,
    nodeVersion: process.version,
    platform: process.platform,
    ci: process.env.CI === "true",
  };

  await mkdir(failureDir, { recursive: true });
  const metadataPath = join(failureDir, "metadata.json");
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2))
  );

  console.log(`[Artifact Preservation] Saved to: ${failureDir}`);
  return failureDir;
}

/**
 * Clean up test data directories.
 */
export async function cleanupTestData(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Clean up old failure artifacts (keep only last N failures).
 */
export async function cleanupOldFailures(
  failuresDir: string,
  keepCount: number = 10
): Promise<void> {
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const entries = await readdir(failuresDir);
    
    if (entries.length <= keepCount) {
      return; // Nothing to clean up
    }

    // Get entries with their timestamps
    const entriesWithStats = await Promise.all(
      entries.map(async (entry) => ({
        name: entry,
        path: join(failuresDir, entry),
        mtime: (await stat(join(failuresDir, entry))).mtime,
      }))
    );

    // Sort by modification time (oldest first)
    entriesWithStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    // Remove oldest entries
    const toRemove = entriesWithStats.slice(0, entries.length - keepCount);
    for (const entry of toRemove) {
      await rm(entry.path, { recursive: true, force: true });
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}
