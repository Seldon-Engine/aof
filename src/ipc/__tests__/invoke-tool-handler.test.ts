/**
 * Unit tests for POST /v1/tool/invoke handler.
 *
 * Bootstraps a throwaway http.Server on a temp Unix socket, attaches the
 * IPC routes, and exercises the envelope + dispatch path end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { attachIpcRoutes } from "../server-attach.js";
import type { IpcDeps } from "../types.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";

function postSocket(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload =
      typeof body === "string" ? body : JSON.stringify(body);
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

describe("POST /v1/tool/invoke handler", () => {
  let server: Server;
  let tmpDir: string;
  let socketPath: string;
  let toolRegistry: ToolRegistry;
  let deps: IpcDeps;
  let resolveStoreMock: ReturnType<typeof vi.fn>;
  let handlerMock: ReturnType<typeof vi.fn>;

  const fakeLogger = { log: vi.fn() } as unknown as IpcDeps["logger"];
  const fakeService = {
    handleSessionEnd: vi.fn().mockResolvedValue(undefined),
    handleAgentEnd: vi.fn().mockResolvedValue(undefined),
    handleMessageReceived: vi.fn().mockResolvedValue(undefined),
  } as unknown as IpcDeps["service"];
  const fakeLog = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as IpcDeps["log"];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-ipc-invoke-"));
    socketPath = join(tmpDir, "daemon.sock");

    handlerMock = vi.fn().mockResolvedValue({ ok: true, scanned: 0 });
    toolRegistry = {
      aof_status_report: {
        description: "status",
        schema: z.object({ agent: z.string().optional() }),
        handler: handlerMock,
      },
    };

    resolveStoreMock = vi.fn().mockResolvedValue({
      projectId: "_inbox",
    } as unknown as import("../../store/interfaces.js").ITaskStore);

    deps = {
      toolRegistry,
      resolveStore: resolveStoreMock,
      logger: fakeLogger,
      service: fakeService,
      log: fakeLog,
    };

    server = createServer(() => {
      /* pass-through — attachIpcRoutes registers its own request listener */
    });
    attachIpcRoutes(server, deps);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen(socketPath);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("dispatches a valid envelope and returns { result }", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "aof_status_report",
      params: {},
      toolCallId: "call-1",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ result: { ok: true, scanned: 0 } });
    expect(handlerMock).toHaveBeenCalledOnce();
    expect(resolveStoreMock).toHaveBeenCalledWith({
      actor: undefined,
      projectId: undefined,
    });
  });

  it("returns 400 validation on invalid envelope (missing toolCallId)", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "aof_status_report",
      params: {},
    });
    expect(status).toBe(400);
    const b = body as { error: { kind: string } };
    expect(b.error.kind).toBe("validation");
  });

  it("returns 400 validation on unknown envelope field (strict mode)", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "aof_status_report",
      params: {},
      toolCallId: "call-1",
      rogueField: 42,
    });
    expect(status).toBe(400);
    expect((body as { error: { kind: string } }).error.kind).toBe("validation");
  });

  it("returns 400 validation when raw body is not JSON", async () => {
    const { status, body } = await postSocket(
      socketPath,
      "/v1/tool/invoke",
      "not-json",
    );
    expect(status).toBe(400);
    expect((body as { error: { kind: string } }).error.kind).toBe("validation");
  });

  it("returns 404 not-found when tool name is not registered", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "aof_nonexistent",
      params: {},
      toolCallId: "call-1",
    });
    expect(status).toBe(404);
    expect((body as { error: { kind: string } }).error.kind).toBe("not-found");
  });

  it("returns 400 validation when inner params fail the tool schema", async () => {
    // `aof_status_report` schema requires `agent?: string`, so passing a number fails.
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "aof_status_report",
      params: { agent: 42 },
      toolCallId: "call-1",
    });
    expect(status).toBe(400);
    expect((body as { error: { kind: string } }).error.kind).toBe("validation");
    expect(
      (body as { error: { message: string } }).error.message,
    ).toContain("aof_status_report");
  });

  it("classifies handler 'permission' errors as 403 kind=permission", async () => {
    handlerMock.mockRejectedValueOnce(new Error("permission denied"));
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "aof_status_report",
      params: {},
      toolCallId: "call-1",
    });
    expect(status).toBe(403);
    expect((body as { error: { kind: string } }).error.kind).toBe("permission");
  });

  it("classifies handler 'not found' errors as 404 kind=not-found", async () => {
    handlerMock.mockRejectedValueOnce(new Error("task not found: t-1"));
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "aof_status_report",
      params: {},
      toolCallId: "call-1",
    });
    expect(status).toBe(404);
    expect((body as { error: { kind: string } }).error.kind).toBe("not-found");
  });

  it("classifies generic handler errors as 500 kind=internal", async () => {
    handlerMock.mockRejectedValueOnce(new Error("boom"));
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "aof_status_report",
      params: {},
      toolCallId: "call-1",
    });
    expect(status).toBe(500);
    expect((body as { error: { kind: string } }).error.kind).toBe("internal");
  });

  it("resolves the store using envelope actor/projectId", async () => {
    await postSocket(socketPath, "/v1/tool/invoke", {
      name: "aof_status_report",
      params: {},
      toolCallId: "call-1",
      actor: "swe-backend",
      projectId: "myproj",
    });
    expect(resolveStoreMock).toHaveBeenCalledWith({
      actor: "swe-backend",
      projectId: "myproj",
    });
  });

  it("returns 405 when method is GET", async () => {
    // Explicit GET against the invoke route.
    const { statusCode } = await new Promise<{ statusCode: number }>(
      (resolve, reject) => {
        const req = httpRequest(
          { socketPath, path: "/v1/tool/invoke", method: "GET" },
          (res) => {
            res.resume();
            resolve({ statusCode: res.statusCode! });
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(statusCode).toBe(405);
  });
});
