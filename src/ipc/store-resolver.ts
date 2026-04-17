/**
 * Daemon-side store resolver.
 *
 * Wraps a base ITaskStore with:
 *   1. Lazy project-scoped store creation + per-process cache.
 *   2. Optional org-chart loading for `PermissionAwareTaskStore` enforcement.
 *
 * Migrated from `src/openclaw/adapter.ts` (D-02 / Phase 43) — the in-plugin
 * singletons (`resolveProjectStore`, `getStoreForActor`, orgChartPromise) now
 * live on the daemon side. Plugin no longer loads the org chart.
 *
 * @module ipc/store-resolver
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import { createProjectStore } from "../projects/store-factory.js";
import { loadOrgChart } from "../org/loader.js";
import { PermissionAwareTaskStore } from "../permissions/task-permissions.js";
import type { OrgChart } from "../schemas/org-chart.js";
import { createLogger } from "../logging/index.js";
import type { ResolveStoreFn } from "./types.js";

const log = createLogger("ipc-store-resolver");

export interface StoreResolverOpts {
  /** Vault root (`opts.dataDir`) — passed to `createProjectStore` as `vaultRoot`. */
  dataDir: string;
  /** The daemon's root ITaskStore (usually a `FilesystemTaskStore` on _inbox or the vault). */
  baseStore: ITaskStore;
  /** Event logger threaded into any per-project store created lazily. */
  logger: EventLogger;
  /** If set, the org chart is loaded once and used to wrap resolved stores in
   *  `PermissionAwareTaskStore` for actors that appear in the chart. */
  orgChartPath?: string;
}

/**
 * Build the IPC resolver closure consumed by `IpcDeps.resolveStore`.
 *
 * The returned function is safe to call concurrently; project stores are
 * cached in a Map and the org chart is loaded at most once.
 */
export function buildDaemonResolveStore(opts: StoreResolverOpts): ResolveStoreFn {
  const projectStores = new Map<string, ITaskStore>();
  const initialized = new WeakSet<ITaskStore>();

  let orgChartPromise: Promise<OrgChart | undefined> | undefined;
  if (opts.orgChartPath) {
    const path = opts.orgChartPath;
    orgChartPromise = loadOrgChart(path)
      .then((r) => {
        if (r.success && r.chart) return r.chart;
        log.warn({ errors: r.errors }, "failed to load org chart for permission enforcement");
        return undefined;
      })
      .catch((err) => {
        log.warn({ err, path }, "failed to load org chart");
        return undefined;
      });
  }

  async function ensureInit(s: ITaskStore): Promise<ITaskStore> {
    if (initialized.has(s)) return s;
    const maybe = s as unknown as { init?: () => Promise<void> };
    if (typeof maybe.init === "function") {
      await maybe.init();
    }
    initialized.add(s);
    return s;
  }

  async function resolveProjectStore(projectId?: string): Promise<ITaskStore> {
    if (!projectId) return ensureInit(opts.baseStore);
    const cached = projectStores.get(projectId);
    if (cached) return ensureInit(cached);
    const { store } = await createProjectStore({
      projectId,
      vaultRoot: opts.dataDir,
      logger: opts.logger,
    });
    projectStores.set(projectId, store);
    return ensureInit(store);
  }

  return async ({ actor, projectId }) => {
    const base = await resolveProjectStore(projectId);
    if (!orgChartPromise || !actor || actor === "unknown") return base;
    const chart = await orgChartPromise;
    if (!chart) return base;
    return new PermissionAwareTaskStore(base, chart, actor);
  };
}
