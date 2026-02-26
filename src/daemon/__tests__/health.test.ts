import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getHealthStatus, getLivenessStatus, setShuttingDown, type DaemonState, type DaemonStatusContext } from "../health.js";
import type { ITaskStore } from "../../store/interfaces.js";

describe("Daemon Health", () => {
  let mockState: DaemonState;
  let mockStore: ITaskStore;
  let mockContext: DaemonStatusContext;

  beforeEach(() => {
    mockState = {
      lastPollAt: Date.now(),
      lastEventAt: Date.now(),
      uptime: 60_000,
    };

    mockStore = {
      countByStatus: vi.fn().mockResolvedValue({
        backlog: 5,
        ready: 3,
        "in-progress": 2,
        blocked: 1,
        done: 10,
      }),
    } as unknown as ITaskStore;

    mockContext = {
      version: "0.1.0",
      dataDir: "/tmp/aof",
      pollIntervalMs: 30_000,
      providersConfigured: 2,
      schedulerRunning: true,
      eventLoggerOk: true,
    };

    // Reset shutdown state
    setShuttingDown(false);
  });

  it("returns healthy status when scheduler is active", async () => {
    const health = await getHealthStatus(mockState, mockStore, mockContext);

    expect(health.status).toBe("healthy");
    expect(health.uptime).toBe(60_000);
    expect(health.taskCounts).toEqual({
      open: 5,
      ready: 3,
      inProgress: 2,
      blocked: 1,
      done: 10,
    });
  });

  it("returns unhealthy when scheduler hasn't polled in 5min", async () => {
    mockState.lastPollAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago

    const health = await getHealthStatus(mockState, mockStore, mockContext);

    expect(health.status).toBe("unhealthy");
  });

  it("returns healthy when last poll is within 5min threshold", async () => {
    mockState.lastPollAt = Date.now() - 4 * 60 * 1000; // 4 minutes ago

    const health = await getHealthStatus(mockState, mockStore, mockContext);

    expect(health.status).toBe("healthy");
  });

  it("includes lastPollAt and lastEventAt timestamps", async () => {
    const health = await getHealthStatus(mockState, mockStore, mockContext);

    expect(health.lastPollAt).toBe(mockState.lastPollAt);
    expect(health.lastEventAt).toBe(mockState.lastEventAt);
  });

  it("returns unhealthy if store.countByStatus throws error", async () => {
    mockStore.countByStatus = vi.fn().mockRejectedValue(new Error("Store error"));

    const health = await getHealthStatus(mockState, mockStore, mockContext);

    expect(health.status).toBe("unhealthy");
  });

  it("completes health check in under 50ms", async () => {
    const start = performance.now();
    await getHealthStatus(mockState, mockStore, mockContext);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(50);
  });

  describe("version, components, config fields", () => {
    it("includes version from context", async () => {
      const health = await getHealthStatus(mockState, mockStore, mockContext);
      expect(health.version).toBe("0.1.0");
    });

    it("includes component status", async () => {
      const health = await getHealthStatus(mockState, mockStore, mockContext);
      expect(health.components).toEqual({
        scheduler: "running",
        store: "ok",
        eventLogger: "ok",
      });
    });

    it("reports store as error when countByStatus fails", async () => {
      mockStore.countByStatus = vi.fn().mockRejectedValue(new Error("fail"));
      const health = await getHealthStatus(mockState, mockStore, mockContext);
      expect(health.components.store).toBe("error");
    });

    it("reports scheduler as stopped when stale", async () => {
      mockState.lastPollAt = Date.now() - 6 * 60 * 1000;
      mockContext.schedulerRunning = false;
      const health = await getHealthStatus(mockState, mockStore, mockContext);
      expect(health.components.scheduler).toBe("stopped");
    });

    it("includes config summary", async () => {
      const health = await getHealthStatus(mockState, mockStore, mockContext);
      expect(health.config).toEqual({
        dataDir: "/tmp/aof",
        pollIntervalMs: 30_000,
        providersConfigured: 2,
      });
    });

    it("defaults to unknown when context is not provided", async () => {
      const health = await getHealthStatus(mockState, mockStore);
      expect(health.version).toBe("unknown");
      expect(health.config.dataDir).toBe("unknown");
    });
  });

  describe("getLivenessStatus", () => {
    it("returns ok when not shutting down", () => {
      const result = getLivenessStatus();
      expect(result).toEqual({ status: "ok" });
    });

    it("returns error when shutting down", () => {
      setShuttingDown(true);
      const result = getLivenessStatus();
      expect(result).toEqual({ status: "error" });
    });
  });
});
