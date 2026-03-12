/**
 * Centralized path resolver for well-known AOF directory structure.
 *
 * All path conventions live here so that components don't need to
 * hard-code subdirectory names.  Every function is pure — takes a
 * base directory and returns an absolute path.
 */

import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Default data directory
// ---------------------------------------------------------------------------

/** Resolve a path to absolute, expanding ~ to homedir. */
export function normalizePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(join(homedir(), p.slice(2)));
  }
  return resolve(p);
}

/**
 * Canonical default when nothing is configured.
 * Must match DEFAULT_AOF_ROOT in projects/resolver.ts — both resolve to ~/.aof.
 */
export const DEFAULT_DATA_DIR = join(homedir(), ".aof");

/**
 * Resolve the effective data directory.
 * Priority: explicit arg > AOF_DATA_DIR env > default.
 */
export function resolveDataDir(explicit?: string): string {
  const raw = explicit ?? process.env["AOF_DATA_DIR"] ?? DEFAULT_DATA_DIR;
  return normalizePath(raw);
}

// ---------------------------------------------------------------------------
// Well-known paths relative to dataDir
// ---------------------------------------------------------------------------

/** Org chart: `<dataDir>/org/org-chart.yaml` */
export function orgChartPath(dataDir: string): string {
  return resolve(join(dataDir, "org", "org-chart.yaml"));
}

/** Project manifest: `<projectRoot>/project.yaml` */
export function projectManifestPath(projectRoot: string): string {
  return resolve(join(projectRoot, "project.yaml"));
}

/** Events directory: `<dataDir>/events` */
export function eventsDir(dataDir: string): string {
  return resolve(join(dataDir, "events"));
}

/** Daemon PID lock file: `<dataDir>/daemon.pid` */
export function daemonPidPath(dataDir: string): string {
  return resolve(join(dataDir, "daemon.pid"));
}

/** Daemon health socket: `<dataDir>/daemon.sock` */
export function daemonSocketPath(dataDir: string): string {
  return resolve(join(dataDir, "daemon.sock"));
}

/** Murmur state directory: `<dataDir>/.murmur` */
export function murmurStateDir(dataDir: string): string {
  return resolve(join(dataDir, ".murmur"));
}

/** Memory database: `<dataDir>/memory.db` */
export function memoryDbPath(dataDir: string): string {
  return resolve(join(dataDir, "memory.db"));
}

/** Run artifacts directory for a task: `<projectRoot>/state/runs/<taskId>` */
export function runArtifactDir(projectRoot: string, taskId: string): string {
  return resolve(join(projectRoot, "state", "runs", taskId));
}
