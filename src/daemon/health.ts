import type { ITaskStore } from "../store/interfaces.js";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  lastPollAt: number;
  lastEventAt: number;
  taskCounts: {
    open: number;
    ready: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  components: {
    scheduler: "running" | "stopped";
    store: "ok" | "error";
    eventLogger: "ok" | "error";
  };
  config: {
    dataDir: string;
    pollIntervalMs: number;
    providersConfigured: number;
  };
}

export interface DaemonState {
  lastPollAt: number;
  lastEventAt: number;
  uptime: number;
}

/** Extended state for rich /status responses. */
export interface DaemonStatusContext {
  version: string;
  dataDir: string;
  pollIntervalMs: number;
  providersConfigured: number;
  schedulerRunning: boolean;
  eventLoggerOk: boolean;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** Whether the daemon process is in shutdown mode. */
let shuttingDown = false;

/** Mark the daemon as shutting down (liveness will report error). */
export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

/**
 * Minimal liveness check for supervisor watchdog.
 * No store queries, no async work -- returns synchronously.
 */
export function getLivenessStatus(): { status: "ok" | "error" } {
  return { status: shuttingDown ? "error" : "ok" };
}

export async function getHealthStatus(
  state: DaemonState,
  store: ITaskStore,
  context?: DaemonStatusContext,
): Promise<HealthStatus> {
  const now = Date.now();

  // Check if scheduler is stale
  const isStale = now - state.lastPollAt > STALE_THRESHOLD_MS;

  // Try to get task counts (basic health check)
  let taskCounts;
  let storeHealthy = true;
  try {
    const counts = await store.countByStatus();
    taskCounts = {
      open: counts.backlog ?? 0,
      ready: counts.ready ?? 0,
      inProgress: counts["in-progress"] ?? 0,
      blocked: counts.blocked ?? 0,
      done: counts.done ?? 0,
    };
  } catch (err) {
    storeHealthy = false;
    taskCounts = {
      open: 0,
      ready: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
    };
  }

  const status = isStale || !storeHealthy ? "unhealthy" : "healthy";

  return {
    status,
    version: context?.version ?? "unknown",
    uptime: state.uptime,
    lastPollAt: state.lastPollAt,
    lastEventAt: state.lastEventAt,
    taskCounts,
    components: {
      scheduler: context?.schedulerRunning ?? !isStale ? "running" : "stopped",
      store: storeHealthy ? "ok" : "error",
      eventLogger: context?.eventLoggerOk ?? true ? "ok" : "error",
    },
    config: {
      dataDir: context?.dataDir ?? "unknown",
      pollIntervalMs: context?.pollIntervalMs ?? 0,
      providersConfigured: context?.providersConfigured ?? 0,
    },
  };
}
