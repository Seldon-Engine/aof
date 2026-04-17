/**
 * IPC wiring integration test.
 *
 * Exercises the full startAofDaemon → attachIpcRoutes → /v1/tool/invoke
 * path against a real Unix socket and the shared toolRegistry. Distinct
 * from src/ipc/__tests__/invoke-tool-handler.test.ts (which stubs deps).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { startAofDaemon } from "../daemon.js";
import type { PollResult } from "../../dispatch/scheduler.js";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

function postSocket(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function getSocket(
  socketPath: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
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

const makePollResult = (): PollResult => ({
  scannedAt: new Date().toISOString(),
  durationMs: 1,
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

describe("startAofDaemon IPC wiring", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let socketPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-ipc-int-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eDir = join(tmpDir, "events");
    await mkdir(eDir, { recursive: true });
    logger = new EventLogger(eDir);
    socketPath = join(tmpDir, "daemon.sock");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("POST /v1/tool/invoke dispatches aof_status_report and returns 200 { result }", async () => {
    const poller = vi.fn(async () => makePollResult());
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

    try {
      const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
        name: "aof_status_report",
        params: {},
        toolCallId: "integration-1",
      });
      expect(status).toBe(200);
      expect(body).toHaveProperty("result");
    } finally {
      if (healthServer) healthServer.close();
      await service.stop();
    }
  });

  it("POST /v1/tool/invoke on unknown tool returns 404 kind=not-found", async () => {
    const poller = vi.fn(async () => makePollResult());
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

    try {
      const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
        name: "aof_bogus",
        params: {},
        toolCallId: "integration-2",
      });
      expect(status).toBe(404);
      expect((body as { error: { kind: string } }).error.kind).toBe("not-found");
    } finally {
      if (healthServer) healthServer.close();
      await service.stop();
    }
  });

  it("POST /v1/event/session-end returns 200 { ok: true }", async () => {
    const poller = vi.fn(async () => makePollResult());
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

    try {
      const { status, body } = await postSocket(
        socketPath,
        "/v1/event/session-end",
        { sessionId: "s-1" },
      );
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
    } finally {
      if (healthServer) healthServer.close();
      await service.stop();
    }
  });

  it("existing /healthz and /status remain functional after IPC attach", async () => {
    const poller = vi.fn(async () => makePollResult());
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

    try {
      const health = await getSocket(socketPath, "/healthz");
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok" });

      const statusResp = await getSocket(socketPath, "/status");
      expect(statusResp.status).toBe(200);
      expect(statusResp.body).toHaveProperty("status", "healthy");
    } finally {
      if (healthServer) healthServer.close();
      await service.stop();
    }
  });
});
