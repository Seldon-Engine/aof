/**
 * Phase 46 / Bug 2C — envelope actor injection regression test.
 *
 * Bug 2C: plugin-originated tasks were being stamped `createdBy: "unknown"`
 * even when the IPC envelope carried an authenticated `actor`. Forensic
 * traceability was lost. The IPC route at `/v1/tool/invoke` destructured
 * `actor` from the envelope but never propagated it into `inner.data`
 * before invoking the tool handler. Handlers like aof_dispatch then fell
 * through to their `input.actor ?? "unknown"` default.
 *
 * These tests pin the daemon-side half of the fix:
 *   1. envelope.actor → inner.data.actor when caller didn't supply one
 *   2. caller-supplied params.actor wins over envelope.actor
 *   3. neither set → inner.data.actor remains undefined (handler default kicks in)
 *
 * Test-server scaffolding mirrors `invoke-tool-handler.test.ts` exactly —
 * UDS server bootstrap, postSocket helper, deps/toolRegistry mocks.
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

describe("Phase 46 / Bug 2C — envelope actor injection", () => {
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
    tmpDir = await mkdtemp(join(tmpdir(), "aof-ipc-bug046e-"));
    socketPath = join(tmpDir, "daemon.sock");

    handlerMock = vi.fn().mockResolvedValue({ ok: true });
    toolRegistry = {
      test_tool: {
        description: "test",
        schema: z.object({
          actor: z.string().optional(),
          somefield: z.string().optional(),
        }),
        handler: handlerMock,
      },
    } as unknown as ToolRegistry;

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
      /* attachIpcRoutes registers its own request listener */
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

  it("envelope.actor is injected into inner.data.actor when absent", async () => {
    const response = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "test_tool",
      params: { somefield: "x" },
      actor: "agent-main",
      toolCallId: "tc-1",
    });
    expect(response.status).toBe(200);
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const innerData = handlerMock.mock.calls[0]![1] as {
      actor?: string;
      somefield?: string;
    };
    expect(innerData.actor).toBe("agent-main");
    expect(innerData.somefield).toBe("x");
  });

  it("explicit inner.data.actor wins over envelope.actor", async () => {
    const response = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "test_tool",
      params: { actor: "explicit-override", somefield: "x" },
      actor: "envelope-agent",
      toolCallId: "tc-2",
    });
    expect(response.status).toBe(200);
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const innerData = handlerMock.mock.calls[0]![1] as { actor?: string };
    expect(innerData.actor).toBe("explicit-override");
  });

  it("no envelope.actor AND no params.actor → inner.data.actor is undefined", async () => {
    const response = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "test_tool",
      params: { somefield: "x" },
      toolCallId: "tc-3",
    });
    expect(response.status).toBe(200);
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const innerData = handlerMock.mock.calls[0]![1] as { actor?: string };
    expect(innerData.actor).toBeUndefined();
  });
});
