/**
 * Snapshot module — pre-migration directory snapshots with restore/prune.
 *
 * Creates full copies of the AOF data directory (excluding the snapshot
 * directory itself) for atomic rollback on migration failure.
 */

import { cp, mkdir, rm, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";

const SNAPSHOT_DIR = ".aof/snapshots";

/**
 * Filter for cp's recursive walk: copy directories, regular files, and
 * symlinks; skip sockets, FIFOs, and block/char devices.
 *
 * A running daemon parks its unix socket under the data dir; including that
 * socket in a snapshot makes downstream cp operations fail with EINVAL
 * ("cannot copy a socket file").
 */
async function isCopyable(src: string): Promise<boolean> {
  try {
    const stat = await lstat(src);
    return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Create a snapshot of the entire data directory.
 *
 * Copies all top-level entries, but for `.aof/` it copies everything
 * EXCEPT the `snapshots/` subdirectory to prevent recursive nesting.
 *
 * @returns The absolute path to the created snapshot directory.
 */
export async function createSnapshot(aofRoot: string): Promise<string> {
  const snapshotBase = join(aofRoot, SNAPSHOT_DIR);
  const name = `snapshot-${Date.now()}`;
  const snapshotPath = join(snapshotBase, name);
  await mkdir(snapshotPath, { recursive: true });

  const entries = await readdir(aofRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!(await isCopyable(join(aofRoot, entry.name)))) continue;

    const src = join(aofRoot, entry.name);
    const dest = join(snapshotPath, entry.name);

    if (entry.name === ".aof") {
      // Copy .aof but exclude snapshots/
      await mkdir(dest, { recursive: true });
      const aofEntries = await readdir(src, { withFileTypes: true });
      for (const ae of aofEntries) {
        if (ae.name === "snapshots") continue;
        if (!(await isCopyable(join(src, ae.name)))) continue;
        await cp(join(src, ae.name), join(dest, ae.name), {
          recursive: true,
          filter: isCopyable,
        });
      }
    } else {
      await cp(src, dest, { recursive: true, filter: isCopyable });
    }
  }

  return snapshotPath;
}

/**
 * Restore a snapshot, replacing all current data.
 *
 * Removes all top-level entries in aofRoot EXCEPT `.aof/snapshots/`,
 * then copies everything from the snapshot back to aofRoot, merging
 * into `.aof/` without touching `snapshots/`.
 */
export async function restoreSnapshot(aofRoot: string, snapshotPath: string): Promise<void> {
  // Remove everything except .aof/snapshots/
  const entries = await readdir(aofRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".aof") {
      // Remove all .aof/* except snapshots/
      const aofEntries = await readdir(join(aofRoot, ".aof"), { withFileTypes: true });
      for (const ae of aofEntries) {
        if (ae.name === "snapshots") continue;
        await rm(join(aofRoot, ".aof", ae.name), { recursive: true, force: true });
      }
    } else {
      await rm(join(aofRoot, entry.name), { recursive: true, force: true });
    }
  }

  // Copy snapshot contents back to aofRoot
  const snapshotEntries = await readdir(snapshotPath, { withFileTypes: true });
  for (const entry of snapshotEntries) {
    const src = join(snapshotPath, entry.name);
    const dest = join(aofRoot, entry.name);

    if (entry.name === ".aof") {
      // Merge into .aof/ without touching snapshots/
      const aofEntries = await readdir(src, { withFileTypes: true });
      for (const ae of aofEntries) {
        if (ae.name === "snapshots") continue;
        if (!(await isCopyable(join(src, ae.name)))) continue;
        await cp(join(src, ae.name), join(aofRoot, ".aof", ae.name), {
          recursive: true,
          filter: isCopyable,
        });
      }
    } else {
      if (!(await isCopyable(src))) continue;
      await cp(src, dest, { recursive: true, filter: isCopyable });
    }
  }
}

/**
 * Prune old snapshots, keeping only the most recent `keep` entries.
 *
 * Sorts snapshot directories by name (which contains a timestamp),
 * removes the oldest until only `keep` remain.
 */
export async function pruneSnapshots(aofRoot: string, keep: number = 2): Promise<void> {
  const snapshotsDir = join(aofRoot, SNAPSHOT_DIR);

  let entries: string[];
  try {
    entries = await readdir(snapshotsDir);
  } catch {
    // Snapshots directory doesn't exist yet, nothing to prune
    return;
  }

  // Sort ascending (oldest first, since names contain timestamps)
  entries.sort();

  if (entries.length <= keep) return;

  const toRemove = entries.slice(0, entries.length - keep);
  for (const entry of toRemove) {
    await rm(join(snapshotsDir, entry), { recursive: true, force: true });
  }
}
