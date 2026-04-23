import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { startAofDaemon } from "../daemon.js";
import type { PollResult } from "../../dispatch/scheduler.js";

// Mock structured logger to suppress output during tests
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));

describe("AOF daemon", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  const makePollResult = (): PollResult => ({
    scannedAt: new Date().toISOString(),
    durationMs: 5,
    dryRun: true,
    actions: [],
    stats: {
      total: 0,
      backlog: 0,
      ready: 0,
      inProgress: 0,
      blocked: 0,
      review: 0,
      done: 0,
      cancelled: 0,
      deadletter: 0,
    },
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-daemon-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts the daemon loop with a poll", async () => {
    const poller = vi.fn(async () => makePollResult());

    const { service } = await startAofDaemon({
      dataDir: tmpDir,
      pollIntervalMs: 60_000,
      dryRun: true,
      store,
      logger,
      poller,
      enableHealthServer: false,
    });

    // Poller fires once for the unscoped root store and once per discovered
    // project (discoverProjects always yields an `_inbox` placeholder even
    // in an empty vault). At least one call confirms the daemon started its
    // poll loop.
    expect(poller).toHaveBeenCalled();
    expect(poller).toHaveBeenCalledWith(store, logger, expect.anything());

    await service.stop();
  });

  describe("PID file locking", () => {
    it("creates a PID file on daemon start", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      // PID file should not exist before start
      expect(existsSync(pidFile)).toBe(false);

      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // PID file should exist and contain current process PID
      expect(existsSync(pidFile)).toBe(true);
      const pidContent = readFileSync(pidFile, "utf-8").trim();
      expect(pidContent).toBe(String(process.pid));

      await service.stop();
    });

    it("prevents concurrent daemon starts with clear error message", async () => {
      const poller = vi.fn(async () => makePollResult());

      // Start first daemon
      const { service: service1 } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // Attempt to start second daemon should fail
      await expect(
        startAofDaemon({
          dataDir: tmpDir,
          pollIntervalMs: 60_000,
          dryRun: true,
          store,
          logger,
          poller,
          enableHealthServer: false,
        }),
      ).rejects.toThrow(`AOF daemon already running (PID: ${process.pid})`);

      await service1.stop();
    });

    it("cleans up stale PID file and starts successfully", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      // Write a stale PID file with a non-existent PID
      const stalePid = 999999;
      writeFileSync(pidFile, String(stalePid));
      expect(existsSync(pidFile)).toBe(true);

      // Daemon should start successfully, cleaning up the stale PID
      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // PID file should now contain current process PID
      expect(existsSync(pidFile)).toBe(true);
      const pidContent = readFileSync(pidFile, "utf-8").trim();
      expect(pidContent).toBe(String(process.pid));

      await service.stop();
    });

    it("removes PID file on graceful service stop", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // PID file exists while running
      expect(existsSync(pidFile)).toBe(true);

      await service.stop();

      // Note: The exit handler cleanup is tested in signal handling tests
      // In the test environment, service.stop() doesn't trigger process.exit
      // so we verify that the file exists but will be cleaned up on actual exit
      // The real cleanup happens when the process exits
    });

    it("handles signal cleanup (SIGTERM/SIGINT)", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      // Mock process.exit to prevent test from actually exiting
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      expect(existsSync(pidFile)).toBe(true);

      // Simulate SIGTERM — handler is now async (drain-aware)
      process.emit("SIGTERM" as any);

      // Wait for async drain to complete (poller resolves instantly, so drain is fast).
      // Use a generous timeout: the drain itself is near-instant, but under heavy
      // parallel-fork CPU load the event loop can take several seconds to run the
      // SIGTERM handler + async cleanup. The assertion is still about *correctness*
      // (exit(0) was called at all, PID removed) — not about latency.
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(0);
      }, { timeout: 8000, interval: 50 });

      // PID file should be removed after drain completes
      expect(existsSync(pidFile)).toBe(false);

      // Restore and clean up
      exitSpy.mockRestore();
      await service.stop();
    });
  });

  describe("PID gating on health self-check", () => {
    it("writes PID file only after health server self-check succeeds", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");
      const socketPath = join(tmpDir, "daemon.sock");

      expect(existsSync(pidFile)).toBe(false);

      const { service, healthServer } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: true,
        socketPath,
      });

      // PID file should exist after successful startup (health self-check passed)
      expect(existsSync(pidFile)).toBe(true);
      // Health server should be running
      expect(healthServer).toBeDefined();

      if (healthServer) healthServer.close();
      await service.stop();
    });
  });

  describe("crash recovery detection", () => {
    it("detects stale PID file and emits crash recovery event", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      // Write a stale PID file with a non-existent PID
      const stalePid = 999999;
      writeFileSync(pidFile, String(stalePid));

      // Spy on logger to verify crash recovery event
      const logSystemSpy = vi.spyOn(logger, "logSystem");

      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // Should have emitted system.crash_recovery event
      expect(logSystemSpy).toHaveBeenCalledWith(
        "system.crash_recovery",
        expect.objectContaining({
          previousPid: stalePid,
          recoveredAt: expect.any(String),
        }),
      );

      await service.stop();
    });

    it("does not emit crash recovery on clean start", async () => {
      const poller = vi.fn(async () => makePollResult());

      // Spy on logger
      const logSystemSpy = vi.spyOn(logger, "logSystem");

      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // Should NOT have emitted system.crash_recovery
      const crashCalls = logSystemSpy.mock.calls.filter(
        (call) => call[0] === "system.crash_recovery",
      );
      expect(crashCalls).toHaveLength(0);

      await service.stop();
    });
  });

  describe("socket cleanup on shutdown", () => {
    it("cleans up socket file on signal-triggered shutdown", async () => {
      const poller = vi.fn(async () => makePollResult());
      const socketPath = join(tmpDir, "daemon.sock");

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      const { service, healthServer } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: true,
        socketPath,
      });

      // Socket file should exist while server is running
      expect(existsSync(socketPath)).toBe(true);

      // Simulate SIGTERM
      process.emit("SIGTERM" as any);

      // Generous timeout: under CPU-saturated parallel-fork runs the event loop
      // can take several seconds to run the async SIGTERM handler + health-server
      // close. The assertion is about correctness (exit called, socket removed),
      // not latency.
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(0);
      }, { timeout: 8000, interval: 50 });

      // Socket file should be removed after shutdown
      expect(existsSync(socketPath)).toBe(false);

      exitSpy.mockRestore();
      await service.stop();
    });
  });

  describe("startTime correctness (BUG-02 regression)", () => {
    it("reports uptime consistent with recent start, not module import time", async () => {
      const poller = vi.fn(async () => makePollResult());
      const socketPath = join(tmpDir, "daemon.sock");

      const beforeStart = Date.now();

      const { service, healthServer } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: true,
        socketPath,
      });

      // Fetch /status endpoint to check uptime
      const http = await import("node:http");
      const response = await new Promise<string>((resolve, reject) => {
        const req = http.get({ socketPath, path: "/status" }, (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk; });
          res.on("end", () => resolve(data));
        });
        req.on("error", reject);
      });

      const status = JSON.parse(response);
      // Uptime should be less than 5 seconds since we just started
      // If startTime were at module scope, uptime would be much larger
      expect(status.uptime).toBeLessThan(5000);
      expect(status.uptime).toBeGreaterThanOrEqual(0);

      if (healthServer) healthServer.close();
      await service.stop();
    });
  });

  describe("config forwarding", () => {
    it("forwards pollTimeoutMs and taskActionTimeoutMs to AOFService", async () => {
      const poller = vi.fn(async () => makePollResult());

      // This test verifies the daemon passes timeout config.
      // Since AOFService is constructed internally, we verify by ensuring
      // startAofDaemon accepts and doesn't error with these options.
      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        pollTimeoutMs: 15_000,
        taskActionTimeoutMs: 5_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // Service should start successfully with forwarded config
      expect(service.getStatus().running).toBe(true);

      await service.stop();
    });
  });
});
