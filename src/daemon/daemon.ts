import { join } from "node:path";
import { TaskStore } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import { AOFService, type AOFServiceConfig } from "../service/aof-service.js";
import type { AOFMetrics } from "../metrics/exporter.js";
import type { poll } from "../dispatch/scheduler.js";

export interface AOFDaemonOptions extends AOFServiceConfig {
  store?: TaskStore;
  logger?: EventLogger;
  metrics?: AOFMetrics;
  poller?: typeof poll;
}

export async function startAofDaemon(opts: AOFDaemonOptions): Promise<AOFService> {
  const store = opts.store ?? new TaskStore(opts.dataDir);
  const logger = opts.logger ?? new EventLogger(join(opts.dataDir, "events"));

  const service = new AOFService(
    {
      store,
      logger,
      metrics: opts.metrics,
      poller: opts.poller,
    },
    {
      dataDir: opts.dataDir,
      dryRun: opts.dryRun,
      pollIntervalMs: opts.pollIntervalMs,
      defaultLeaseTtlMs: opts.defaultLeaseTtlMs,
    },
  );

  await service.start();
  return service;
}
