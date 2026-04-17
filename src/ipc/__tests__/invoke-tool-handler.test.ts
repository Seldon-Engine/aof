/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers decision D-06: single /v1/tool/invoke envelope handler that:
 *   - dispatches against a tool registry (shared w/ MCP/OpenClaw path)
 *   - validates envelope + inner params via Zod
 *   - maps handler errors to canonical IpcErrorKind envelopes
 *   - returns HTTP status per error kind (400/403/404/500)
 *
 * RED anchor: imports from "../routes/invoke-tool.js" which does not yet exist.
 * Wave 1 lands `src/ipc/routes/invoke-tool.ts` exporting `handleInvokeTool`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { handleInvokeTool } from "../routes/invoke-tool.js"; // INTENTIONALLY MISSING — Wave 1 creates this (D-06).

/** Helper: POST JSON to a Unix-socket HTTP server. */
function postSocket(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
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
        res.on("data", (chunk) => (data += chunk));
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

describe("IPC /v1/tool/invoke handler (D-06)", () => {
  let server: Server;
  let tmpDir: string;
  let socketPath: string;
  /** Shape-compatible mock registry. Wave 1 dispatches against the real `toolRegistry`. */
  let mockRegistry: Record<
    string,
    { description: string; schema: z.ZodType; handler: (ctx: unknown, input: unknown) => Promise<unknown> }
  >;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-ipc-invoke-test-"));
    socketPath = join(tmpDir, "daemon.sock");

    mockRegistry = {
      test_tool: {
        description: "test",
        schema: z.object({ x: z.number() }),
        handler: async (_ctx, input) => ({ ok: true, x: (input as { x: number }).x }),
      },
      permission_tool: {
        description: "throws permission error",
        schema: z.object({}),
        handler: async () => {
          throw new Error("permission denied: actor cannot do this");
        },
      },
      boom_tool: {
        description: "throws internal",
        schema: z.object({}),
        handler: async () => {
          throw new Error("unexpected failure");
        },
      },
    };

    const mockResolveStore = async (_opts: { actor?: string; projectId?: string }) => ({} as unknown);
    const mockLogger = {
      log: async () => undefined,
    } as unknown;

    server = createServer(async (req, res) => {
      try {
        await handleInvokeTool(req, res, {
          toolRegistry: mockRegistry as unknown as Parameters<typeof handleInvokeTool>[2]["toolRegistry"],
          resolveStore: mockResolveStore as unknown as Parameters<typeof handleInvokeTool>[2]["resolveStore"],
          logger: mockLogger as unknown as Parameters<typeof handleInvokeTool>[2]["logger"],
        });
      } catch {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      }
    });
    server.listen(socketPath);
    await new Promise<void>((resolve) => server.on("listening", resolve));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("D-06: valid envelope + registered tool returns 200 with { result }", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "test_tool",
      params: { x: 42 },
      toolCallId: "tc-1",
    });
    expect(status).toBe(200);
    const b = body as { result?: { ok: boolean; x: number } };
    expect(b.result).toEqual({ ok: true, x: 42 });
  });

  it("D-06: unknown tool name returns 404 with `not-found` kind", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "no_such_tool",
      params: {},
      toolCallId: "tc-2",
    });
    expect(status).toBe(404);
    const b = body as { error: { kind: string } };
    expect(b.error.kind).toBe("not-found");
  });

  it("D-06: malformed envelope (missing `name`) returns 400 with `validation` kind", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      params: {},
      toolCallId: "tc-3",
    });
    expect(status).toBe(400);
    const b = body as { error: { kind: string } };
    expect(b.error.kind).toBe("validation");
  });

  it("D-06: inner params failing tool schema returns 400 with validation details", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "test_tool",
      params: { x: "not-a-number" },
      toolCallId: "tc-4",
    });
    expect(status).toBe(400);
    const b = body as { error: { kind: string; details?: { issues?: unknown[] } } };
    expect(b.error.kind).toBe("validation");
    expect(b.error.details?.issues).toBeDefined();
  });

  it("D-06: handler throwing permission error returns 403 with `permission` kind", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "permission_tool",
      params: {},
      toolCallId: "tc-5",
    });
    expect(status).toBe(403);
    const b = body as { error: { kind: string } };
    expect(b.error.kind).toBe("permission");
  });

  it("D-06: handler throwing generic error returns 500 with `internal` kind", async () => {
    const { status, body } = await postSocket(socketPath, "/v1/tool/invoke", {
      name: "boom_tool",
      params: {},
      toolCallId: "tc-6",
    });
    expect(status).toBe(500);
    const b = body as { error: { kind: string } };
    expect(b.error.kind).toBe("internal");
  });
});
