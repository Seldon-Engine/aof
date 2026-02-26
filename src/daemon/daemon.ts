import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { AOFService, type AOFServiceConfig } from "../service/aof-service.js";
import type { AOFMetrics } from "../metrics/exporter.js";
import type { poll } from "../dispatch/scheduler.js";
import { createHealthServer, selfCheck, type DaemonStateProvider, type StatusContextProvider } from "./server.js";
import { setShuttingDown } from "./health.js";

export interface AOFDaemonOptions extends AOFServiceConfig {
  store?: ITaskStore;
  logger?: EventLogger;
  metrics?: AOFMetrics;
  poller?: typeof poll;
  /** Path to Unix domain socket for health server. Default: join(dataDir, "daemon.sock"). */
  socketPath?: string;
  enableHealthServer?: boolean;
}

export interface AOFDaemonContext {
  service: AOFService;
  healthServer?: Server;
}

const startTime = Date.now();

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 checks existence
    return true;
  } catch {
    return false;
  }
}

export async function startAofDaemon(opts: AOFDaemonOptions): Promise<AOFDaemonContext> {
  const store = opts.store ?? new FilesystemTaskStore(opts.dataDir);
  const logger = opts.logger ?? new EventLogger(join(opts.dataDir, "events"));
  const socketPath = opts.socketPath ?? join(opts.dataDir, "daemon.sock");
  const lockFile = join(opts.dataDir, "daemon.pid");

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
      version: "0.1.0", // TODO: read from package.json
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
  }

  // --- Step 4: Write PID file ONLY after self-check succeeds ---
  writeFileSync(lockFile, String(process.pid));

  // --- Step 5: Start service (begins polling) ---
  await service.start();

  // --- Step 6: Emit crash recovery event if applicable ---
  if (previousPid !== undefined) {
    console.info(`[AOF] Recovered from crash (previous PID: ${previousPid})`);
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
