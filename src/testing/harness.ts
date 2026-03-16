/**
 * Shared test harness for AOF integration tests.
 *
 * Creates a temporary project directory with a real FilesystemTaskStore
 * and EventLogger, plus bound helper functions for reading events/tasks.
 * Auto-cleanup removes the tmpDir recursively.
 */

import { mkdtemp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { BaseEvent } from "../schemas/event.js";
import { readEventLogEntries } from "./event-log-reader.js";
import { readTasksInDir } from "./task-reader.js";
import { getMetricValue } from "./metrics-reader.js";

export interface TestHarness {
  /** Temporary project root directory. */
  tmpDir: string;
  /** Initialized FilesystemTaskStore. */
  store: ITaskStore;
  /** EventLogger writing to eventsDir. */
  logger: EventLogger;
  /** Path to the events directory. */
  eventsDir: string;
  /** Remove tmpDir recursively. */
  cleanup(): Promise<void>;
  /** Read all events from the harness eventsDir. */
  readEvents(): Promise<BaseEvent[]>;
  /** Read all tasks from the store's tasksDir (scans all status subdirectories). */
  readTasks(): Promise<Array<ReturnType<typeof import("../store/task-store.js").parseTaskFile>>>;
  /** Convenience re-export of getMetricValue for metric assertions. */
  getMetric: typeof getMetricValue;
}

/**
 * Read tasks from all status subdirectories under tasksDir.
 * FilesystemTaskStore uses tasks/<status>/<id>.md layout.
 */
async function readAllTasks(tasksDir: string) {
  const entries = await readdir(tasksDir).catch(() => []);
  const allTasks: Array<ReturnType<typeof import("../store/task-store.js").parseTaskFile>> = [];
  for (const entry of entries) {
    const entryPath = join(tasksDir, entry);
    const s = await stat(entryPath).catch(() => null);
    if (s?.isDirectory()) {
      const subTasks = await readTasksInDir(entryPath);
      allTasks.push(...subTasks);
    }
  }
  return allTasks;
}

/**
 * Create a test harness with a temporary project directory.
 *
 * @param prefix - Optional prefix for the tmpDir name (default: "aof-test-")
 * @returns Initialized TestHarness
 */
export async function createTestHarness(prefix?: string): Promise<TestHarness> {
  const effectivePrefix = prefix ? `${prefix}-` : "aof-test-";
  const tmpDir = await mkdtemp(join(tmpdir(), effectivePrefix));

  const store = new FilesystemTaskStore(tmpDir);
  await store.init();

  const eventsDir = join(tmpDir, "events");
  await mkdir(eventsDir, { recursive: true });
  const logger = new EventLogger(eventsDir);

  return {
    tmpDir,
    store,
    logger,
    eventsDir,
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
    readEvents: async () => readEventLogEntries(eventsDir),
    readTasks: async () => readAllTasks(store.tasksDir),
    getMetric: getMetricValue,
  };
}

/**
 * Run a callback with a test harness, auto-cleaning up afterward.
 * Cleanup runs even if the callback throws.
 *
 * @param fn - Callback receiving the harness
 * @param prefix - Optional prefix for the tmpDir name
 */
export async function withTestProject(
  fn: (harness: TestHarness) => Promise<void>,
  prefix?: string,
): Promise<void> {
  const harness = await createTestHarness(prefix);
  try {
    await fn(harness);
  } finally {
    await harness.cleanup();
  }
}
