import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHealthServer, selfCheck, type DaemonStateProvider, type StatusContextProvider } from "../server.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

/** Helper: make an HTTP request to a Unix socket and return status + body. */
function fetchSocket(socketPath: string, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Health Endpoint Server (Unix Socket)", () => {
  let server: Server;
  let mockStateProvider: DaemonStateProvider;
  let mockContextProvider: StatusContextProvider;
  let mockStore: ITaskStore;
  let tmpDir: string;
  let socketPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-server-test-"));
    socketPath = join(tmpDir, "daemon.sock");

    mockStateProvider = vi.fn(() => ({
      lastPollAt: Date.now(),
      lastEventAt: Date.now(),
      uptime: 60_000,
    }));

    mockContextProvider = vi.fn(() => ({
      version: "0.1.0",
      dataDir: "/tmp/aof",
      pollIntervalMs: 30_000,
      providersConfigured: 2,
      schedulerRunning: true,
      eventLoggerOk: true,
    }));

    mockStore = {
      countByStatus: vi.fn().mockResolvedValue({
        backlog: 2,
        ready: 3,
        "in-progress": 2,
        blocked: 1,
        review: 0,
        done: 10,
        deadletter: 0,
      }),
    } as unknown as ITaskStore;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("GET /healthz returns 200 with { status: 'ok' }", async () => {
    server = createHealthServer(mockStateProvider, mockStore, socketPath, mockContextProvider);
    await new Promise<void>((resolve) => server.on("listening", resolve));

    const { status, body } = await fetchSocket(socketPath, "/healthz");

    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("GET /status returns 200 with full JSON when healthy", async () => {
    server = createHealthServer(mockStateProvider, mockStore, socketPath, mockContextProvider);
    await new Promise<void>((resolve) => server.on("listening", resolve));

    const { status, body } = await fetchSocket(socketPath, "/status");

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.status).toBe("healthy");
    expect(b.version).toBe("0.1.0");
    expect(b.uptime).toBe(60_000);
    expect(b.taskCounts).toEqual({
      open: 2,
      ready: 3,
      inProgress: 2,
      blocked: 1,
      done: 10,
    });
    expect(b.components).toEqual({
      scheduler: "running",
      store: "ok",
      eventLogger: "ok",
    });
    expect(b.config).toEqual({
      dataDir: "/tmp/aof",
      pollIntervalMs: 30_000,
      providersConfigured: 2,
    });
  });

  it("GET /status returns 503 when unhealthy", async () => {
    mockStateProvider = vi.fn(() => ({
      lastPollAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      lastEventAt: Date.now(),
      uptime: 60_000,
    }));

    server = createHealthServer(mockStateProvider, mockStore, socketPath, mockContextProvider);
    await new Promise<void>((resolve) => server.on("listening", resolve));

    const { status, body } = await fetchSocket(socketPath, "/status");

    expect(status).toBe(503);
    expect((body as Record<string, unknown>).status).toBe("unhealthy");
  });

  it("unknown routes return 404", async () => {
    server = createHealthServer(mockStateProvider, mockStore, socketPath, mockContextProvider);
    await new Promise<void>((resolve) => server.on("listening", resolve));

    const { status, body } = await fetchSocket(socketPath, "/unknown");

    expect(status).toBe(404);
    expect(body).toBe("Not Found");
  });

  it("removes stale socket file on startup", async () => {
    // Create a stale socket file (just a regular file as stand-in)
    const { writeFileSync } = await import("node:fs");
    writeFileSync(socketPath, "stale");
    expect(existsSync(socketPath)).toBe(true);

    server = createHealthServer(mockStateProvider, mockStore, socketPath, mockContextProvider);
    await new Promise<void>((resolve) => server.on("listening", resolve));

    // Server should be functional despite stale file
    const { status } = await fetchSocket(socketPath, "/healthz");
    expect(status).toBe(200);
  });

  describe("selfCheck", () => {
    it("returns true when server is listening", async () => {
      server = createHealthServer(mockStateProvider, mockStore, socketPath, mockContextProvider);
      await new Promise<void>((resolve) => server.on("listening", resolve));

      const result = await selfCheck(socketPath);
      expect(result).toBe(true);
    });

    it("returns false when no server is listening", async () => {
      const result = await selfCheck(join(tmpDir, "nonexistent.sock"));
      expect(result).toBe(false);
    });
  });
});
