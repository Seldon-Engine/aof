/**
 * Daemon-side taskId → ITaskStore resolution.
 *
 * `task.transitioned` events carry only `taskId`, not `projectId`, so the
 * chat-delivery notifier needs to find which project store owns a given task.
 * This module provides a lazy, cached resolver that tries the unscoped base
 * store first, then scans known projects via `discoverProjects()`, caching
 * `taskId → projectId` to amortize the cost across repeated events.
 *
 * @module daemon/resolve-store-for-task
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import { createProjectStore } from "../projects/store-factory.js";
import { discoverProjects } from "../projects/registry.js";
import { createLogger } from "../logging/index.js";

const log = createLogger("resolve-store-for-task");

export interface ResolveStoreForTaskOpts {
  /** Vault root (`opts.dataDir`). */
  dataDir: string;
  /** The daemon's unscoped base store — tasks at vault root are looked up here first. */
  baseStore: ITaskStore;
  /** Event logger threaded into any per-project store created lazily. */
  logger: EventLogger;
}

/**
 * Build a `(taskId) => Promise<ITaskStore | undefined>` closure.
 *
 * Resolution order on first lookup:
 *   1. `baseStore.get(taskId)` — vault-root tasks.
 *   2. For each discovered project: lazily create its store and probe.
 *
 * Hits are cached indefinitely. Misses are NOT cached (a task that is
 * `ready` on first lookup may resolve to `done` later with a different
 * on-disk path — the store's get() handles that internally).
 */
export function buildResolveStoreForTask(
  opts: ResolveStoreForTaskOpts,
): (taskId: string) => Promise<ITaskStore | undefined> {
  const taskToStore = new Map<string, ITaskStore>();
  const projectStores = new Map<string, ITaskStore>();

  async function getProjectStore(projectId: string): Promise<ITaskStore | undefined> {
    const cached = projectStores.get(projectId);
    if (cached) return cached;
    try {
      const { store } = await createProjectStore({
        projectId,
        vaultRoot: opts.dataDir,
        logger: opts.logger,
      });
      projectStores.set(projectId, store);
      return store;
    } catch (err) {
      log.debug({ err, projectId }, "failed to create project store");
      return undefined;
    }
  }

  return async (taskId: string): Promise<ITaskStore | undefined> => {
    const cached = taskToStore.get(taskId);
    if (cached) {
      // Re-verify: the task may have moved status directories, but the same
      // store still owns it.
      return cached;
    }

    // 1. Vault-root tasks.
    try {
      const root = await opts.baseStore.get(taskId);
      if (root) {
        taskToStore.set(taskId, opts.baseStore);
        return opts.baseStore;
      }
    } catch {
      // fall through to project scan
    }

    // 2. Scan projects.
    const projects = await discoverProjects(opts.dataDir).catch(() => []);
    for (const rec of projects) {
      const store = await getProjectStore(rec.id);
      if (!store) continue;
      try {
        const task = await store.get(taskId);
        if (task) {
          taskToStore.set(taskId, store);
          return store;
        }
      } catch {
        // project store probe failed — keep scanning
      }
    }

    return undefined;
  };
}
