/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers the plugin-side IPC client that talks to the daemon over the same
 * Unix socket (`daemon.sock`) as `/healthz` + `/status`. Mirrors:
 *   - D-05: Unix-socket transport extends existing server.
 *   - D-06: single invokeTool envelope.
 *   - D-09: long-poll spawn callback (GET /v1/spawns/wait returns 200|204).
 *   - D-11: module-level singleton survives OpenClaw plugin reload (Pitfall 3).
 *
 * RED anchor: imports `DaemonIpcClient` + `ensureDaemonIpcClient` from
 * "../daemon-ipc-client.js" which does not yet exist. Wave 3 lands
 * `src/openclaw/daemon-ipc-client.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonIpcClient,
  ensureDaemonIpcClient,
} from "../daemon-ipc-client.js"; // INTENTIONALLY MISSING — Wave 3 creates this.

/**
 * Spin up an in-test HTTP server on a Unix socket that stands in for the
 * daemon. Each test configures the handler to produce the contract response.
 */
async function startStubDaemon(
  socketPath: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  });
  server.listen(socketPath);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  return server;
}

describe("DaemonIpcClient (D-05, D-06, D-09)", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: Server | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-ipc-client-test-"));
    socketPath = join(tmpDir, "daemon.sock");
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("D-05: constructs successfully with a socketPath", () => {
    const client = new DaemonIpcClient(socketPath);
    expect(client).toBeDefined();
  });

  it("D-06: invokeTool POSTs envelope to /v1/tool/invoke and parses response", async () => {
    let receivedPath: string | undefined;
    let receivedMethod: string | undefined;
    let receivedBody: string | undefined;

    server = await startStubDaemon(socketPath, async (req, res) => {
      receivedPath = req.url;
      receivedMethod = req.method;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      receivedBody = Buffer.concat(chunks).toString("utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { ok: true, echoedTool: "aof_dispatch" } }));
    });

    const client = new DaemonIpcClient(socketPath);
    const response = await client.invokeTool({
      pluginId: "openclaw",
      name: "aof_dispatch",
      params: { title: "X" },
      toolCallId: "tc-1",
      callbackDepth: 0,
    });

    expect(receivedPath).toBe("/v1/tool/invoke");
    expect(receivedMethod).toBe("POST");
    expect(JSON.parse(receivedBody!).name).toBe("aof_dispatch");
    expect((response as { result?: unknown }).result).toEqual({
      ok: true,
      echoedTool: "aof_dispatch",
    });
  });

  it("D-06: invokeTool resolves with error envelope on daemon 503 (does not throw)", async () => {
    server = await startStubDaemon(socketPath, async (_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { kind: "unavailable", message: "daemon busy" } }));
    });

    const client = new DaemonIpcClient(socketPath);
    const response = await client.invokeTool({
      pluginId: "openclaw",
      name: "aof_dispatch",
      params: {},
      toolCallId: "tc-2",
      callbackDepth: 0,
    });

    // Must not throw; error is reported via envelope.
    expect((response as { error?: { kind: string } }).error?.kind).toBe("unavailable");
  });

  it("D-09: waitForSpawn returns undefined on HTTP 204 (keepalive)", async () => {
    server = await startStubDaemon(socketPath, async (_req, res) => {
      res.writeHead(204);
      res.end();
    });

    const client = new DaemonIpcClient(socketPath);
    const result = await client.waitForSpawn(5_000);
    expect(result).toBeUndefined();
  });

  it("D-09: waitForSpawn returns parsed SpawnRequest on HTTP 200", async () => {
    server = await startStubDaemon(socketPath, async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "spawn-1",
          taskId: "task-1",
          taskPath: "/tmp/tasks/ready/task-1",
          agent: "swe-backend",
          priority: "normal",
          routing: {},
        }),
      );
    });

    const client = new DaemonIpcClient(socketPath);
    const result = await client.waitForSpawn(5_000);
    expect(result).toMatchObject({ id: "spawn-1", taskId: "task-1", agent: "swe-backend" });
  });

  it("D-09: postSpawnResult POSTs to /v1/spawns/:id/result", async () => {
    let receivedPath: string | undefined;
    let receivedMethod: string | undefined;
    let receivedBody: string | undefined;

    server = await startStubDaemon(socketPath, async (req, res) => {
      receivedPath = req.url;
      receivedMethod = req.method;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      receivedBody = Buffer.concat(chunks).toString("utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const client = new DaemonIpcClient(socketPath);
    await client.postSpawnResult("spawn-1", {
      sessionId: "real-sess",
      success: true,
      aborted: false,
      durationMs: 42,
    });

    expect(receivedPath).toBe("/v1/spawns/spawn-1/result");
    expect(receivedMethod).toBe("POST");
    expect(JSON.parse(receivedBody!).sessionId).toBe("real-sess");
  });

  it("Pitfall 3: ensureDaemonIpcClient returns SAME instance for identical socketPath", () => {
    const a = ensureDaemonIpcClient({ socketPath: "/tmp/same.sock" });
    const b = ensureDaemonIpcClient({ socketPath: "/tmp/same.sock" });
    expect(a).toBe(b);
  });

  it("Pitfall 3: ensureDaemonIpcClient returns NEW instance when socketPath differs", () => {
    const a = ensureDaemonIpcClient({ socketPath: "/tmp/A.sock" });
    const b = ensureDaemonIpcClient({ socketPath: "/tmp/B.sock" });
    expect(a).not.toBe(b);
  });
});
