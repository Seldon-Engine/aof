import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { eventsDir, daemonSocketPath, daemonPidPath } from "../config/paths.js";
import type { Server } from "node:http";
import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { AOFService, type AOFServiceConfig } from "../service/aof-service.js";
import type { AOFMetrics } from "../metrics/exporter.js";
import type { poll } from "../dispatch/scheduler.js";
import { createHealthServer, selfCheck, type DaemonStateProvider, type StatusContextProvider } from "./server.js";
import { setShuttingDown } from "./health.js";
import { VERSION } from "../version.js";
import { StandaloneAdapter } from "./standalone-adapter.js";
import { createLogger } from "../logging/index.js";
import { toolRegistry } from "../tools/tool-registry.js";
import { buildDaemonResolveStore } from "../ipc/store-resolver.js";
import { attachIpcRoutes } from "../ipc/server-attach.js";

const log = createLogger("daemon");

export interface AOFDaemonOptions extends AOFServiceConfig {
  store?: ITaskStore;
  logger?: EventLogger;
  metrics?: AOFMetrics;
  poller?: typeof poll;
  /** Path to Unix domain socket for health server. Default: join(dataDir, "daemon.sock"). */
  socketPath?: string;
  enableHealthServer?: boolean;
  /** Gateway URL for standalone executor (default: env OPENCLAW_GATEWAY_URL or http://localhost:3000). */
  gatewayUrl?: string;
  /** Gateway auth token for standalone executor (default: env OPENCLAW_GATEWAY_TOKEN). */
  gatewayToken?: string;
  /** Path to the org chart YAML (enables PermissionAwareTaskStore wrapping in the
   *  daemon-side IPC store resolver). When omitted, IPC dispatch uses the raw
   *  per-project store without permission enforcement. */
  orgChartPath?: string;
}

export interface AOFDaemonContext {
  service: AOFService;
  healthServer?: Server;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 checks existence
    return true;
  } catch {
    return false;
  }
}

export async function startAofDaemon(opts: AOFDaemonOptions): Promise<AOFDaemonContext> {
  const startTime = Date.now();
  const store = opts.store ?? new FilesystemTaskStore(opts.dataDir);
  const logger = opts.logger ?? new EventLogger(eventsDir(opts.dataDir));
  const socketPath = opts.socketPath ?? daemonSocketPath(opts.dataDir);
  const lockFile = daemonPidPath(opts.dataDir);

  // Reset shutdown flag from any previous run in this process (important for tests)
  setShuttingDown(false);

  // --- Crash recovery detection ---
  let previousPid: number | undefined;

  if (existsSync(lockFile)) {
    const pidStr = readFileSync(lockFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);

    if (!isNaN(pid) && isProcessRunning(pid)) {
      throw new Error(`AOF daemon already running (PID: ${pid})`);
    } else {
      // Stale PID file — previous instance crashed
      previousPid = isNaN(pid) ? undefined : pid;
      unlinkSync(lockFile);
    }
  }

  // --- Step 1: Create AOFService (constructor only, no start) ---
  const executor = opts.dryRun
    ? undefined
    : new StandaloneAdapter({ gatewayUrl: opts.gatewayUrl, gatewayToken: opts.gatewayToken });

  const service = new AOFService(
    {
      store,
      logger,
      metrics: opts.metrics,
      poller: opts.poller,
      executor,
    },
    {
      dataDir: opts.dataDir,
      dryRun: opts.dryRun,
      pollIntervalMs: opts.pollIntervalMs,
      defaultLeaseTtlMs: opts.defaultLeaseTtlMs,
      pollTimeoutMs: opts.pollTimeoutMs,
      taskActionTimeoutMs: opts.taskActionTimeoutMs,
    },
  );

  // --- Step 2: Start health server on Unix socket ---
  let healthServer: Server | undefined;
  if (opts.enableHealthServer ?? true) {
    const getState: DaemonStateProvider = () => {
      const status = service.getStatus();
      return {
        lastPollAt: status.lastPollAt ? new Date(status.lastPollAt).getTime() : Date.now(),
        lastEventAt: logger.lastEventAt || Date.now(),
        uptime: Date.now() - startTime,
      };
    };

    const getContext: StatusContextProvider = () => ({
      version: VERSION,
      dataDir: opts.dataDir,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
      providersConfigured: 0, // TODO: wire to actual provider count
      schedulerRunning: service.getStatus().running,
      eventLoggerOk: true,
    });

    healthServer = createHealthServer(getState, store, socketPath, getContext);

    // Wait for the server to be listening
    await new Promise<void>((resolve, reject) => {
      healthServer!.on("listening", resolve);
      healthServer!.on("error", reject);
    });

    // --- Step 3: Self-check ---
    const healthy = await selfCheck(socketPath);
    if (!healthy) {
      healthServer.close();
      throw new Error("Health server failed to start");
    }

    // --- Step 3a: Attach /v1/* IPC routes (D-05/D-06/D-07 A1) ---
    const resolveStore = buildDaemonResolveStore({
      dataDir: opts.dataDir,
      baseStore: store,
      logger,
      orgChartPath: opts.orgChartPath,
    });
    attachIpcRoutes(healthServer, {
      toolRegistry,
      resolveStore,
      logger,
      service,
      log,
    });
  }

  // --- Step 4: Write PID file ONLY after self-check succeeds ---
  writeFileSync(lockFile, String(process.pid));

  // --- Step 5: Start service (begins polling) ---
  await service.start();

  // --- Step 6: Emit crash recovery event if applicable ---
  if (previousPid !== undefined) {
    log.info({ previousPid }, "recovered from crash");
    try {
      await logger.logSystem("system.crash_recovery", {
        previousPid,
        recoveredAt: new Date().toISOString(),
      });
    } catch {
      // Logging errors should not block startup
    }
  }

  // Cleanup on exit
  process.on("exit", () => {
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
    // Clean up socket file
    try {
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    } catch {
      // Best effort
    }
  });

  // Handle SIGTERM/SIGINT with drain-aware shutdown
  const drainAndExit = async () => {
    setShuttingDown(true);
    await service.stop();
    if (healthServer) healthServer.close();
    if (existsSync(lockFile)) unlinkSync(lockFile);
    // Clean up socket file
    try {
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    } catch {
      // Best effort
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => { void drainAndExit(); });
  process.on("SIGINT", () => { void drainAndExit(); });

  return { service, healthServer };
}
