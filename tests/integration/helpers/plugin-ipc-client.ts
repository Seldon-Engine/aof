/**
 * Phase 43 — Tiny plugin-side IPC client for integration tests.
 *
 * Wraps `http.request({ socketPath })` for the Wave 1+ IPC routes on
 * `daemon.sock`. Intentionally standalone: this helper does NOT import from
 * `src/ipc/*` (which doesn't exist yet) — it carries local minimal type
 * declarations that mirror the production schema shape, so Wave 0 tests
 * typecheck even before Wave 1 lands.
 *
 * Pitfall 4 (from 43-PATTERNS.md §spawn-wait.ts L191): never use the global
 * `fetch` API against a Unix socket — Node's `AbortSignal.timeout` is
 * unreliable in some Node versions when `fetch` is used with `socketPath`.
 * Only `node:http` here.
 */

import { request as httpRequest } from "node:http";

// ─────────────────────────────────────────────────────────────────────────────
// Local minimal types — mirror the shape that Wave 1 lands in src/ipc/schemas.ts
// ─────────────────────────────────────────────────────────────────────────────

/** Envelope POSTed to /v1/tool/invoke (D-06). */
export interface InvokeToolEnvelope {
  pluginId?: string;
  name: string;
  params: Record<string, unknown>;
  actor?: string;
  projectId?: string;
  correlationId?: string;
  toolCallId: string;
  callbackDepth?: number;
}

/** Error envelope returned by /v1/* routes on failure. */
export interface IpcError {
  kind: string;
  message: string;
  details?: unknown;
}

/** Result envelope returned by /v1/tool/invoke on success. */
export interface InvokeToolResponse {
  result?: unknown;
  error?: IpcError;
}

/** Spawn request delivered by /v1/spawns/wait on success (D-09). */
export interface SpawnRequestLike {
  id: string;
  taskId?: string;
  agent?: string;
  priority?: string;
  routing?: unknown;
  projectId?: string;
  projectRoot?: string;
  timeoutMs?: number;
  correlationId?: string;
  [key: string]: unknown;
}

/** Payload POSTed to /v1/spawns/{id}/result (D-09). */
export interface SpawnResultPostLike {
  sessionId: string;
  success: boolean;
  aborted?: boolean;
  error?: { kind: string; message: string };
  durationMs?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw HTTP-over-Unix-socket helpers
// ─────────────────────────────────────────────────────────────────────────────

interface RawResponse {
  statusCode: number;
  body: string;
}

async function requestRaw(
  socketPath: string,
  path: string,
  method: "GET" | "POST",
  body: string | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = httpRequest(
      { socketPath, path, method, timeout: timeoutMs, headers },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: data });
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`IPC timeout after ${timeoutMs}ms on ${path}`));
    });

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function parseJsonSafe(body: string): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /v1/tool/invoke — send an invokeTool envelope, return the response.
 *
 * Returns the raw response body (parsed as JSON if possible). Non-2xx responses
 * are NOT thrown — callers assert on `{ result } | { error: ... }` themselves.
 */
export async function invokeTool(
  socketPath: string,
  envelope: InvokeToolEnvelope,
  timeoutMs = 30_000,
): Promise<InvokeToolResponse> {
  const payload = JSON.stringify(envelope);
  const { body } = await requestRaw(
    socketPath,
    "/v1/tool/invoke",
    "POST",
    payload,
    timeoutMs,
  );
  const parsed = parseJsonSafe(body);
  return (parsed ?? {}) as InvokeToolResponse;
}

/**
 * GET /v1/spawns/wait — long-poll the daemon for a pending spawn.
 *
 * Returns `undefined` when the daemon sends a 204 keepalive (no spawn within
 * the server-side keepalive window). Returns the parsed SpawnRequest on 200.
 *
 * The default `timeoutMs` is 35s — longer than the 25–30s keepalive window
 * specified in 43-PATTERNS.md §spawn-wait.ts so tests observe the 204 path
 * without a client-side cutoff.
 */
export async function waitForSpawn(
  socketPath: string,
  timeoutMs = 35_000,
): Promise<SpawnRequestLike | undefined> {
  const { statusCode, body } = await requestRaw(
    socketPath,
    "/v1/spawns/wait",
    "GET",
    undefined,
    timeoutMs,
  );
  if (statusCode === 204) return undefined;
  if (statusCode === 200) {
    return parseJsonSafe(body) as SpawnRequestLike;
  }
  throw new Error(`waitForSpawn: unexpected status ${statusCode}: ${body}`);
}

/**
 * POST /v1/spawns/{id}/result — deliver spawn outcome back to the daemon.
 *
 * Resolves on success (2xx). Throws on non-2xx so tests can assert the
 * daemon accepted the result.
 */
export async function postSpawnResult(
  socketPath: string,
  id: string,
  result: SpawnResultPostLike,
  timeoutMs = 10_000,
): Promise<void> {
  const path = `/v1/spawns/${encodeURIComponent(id)}/result`;
  const payload = JSON.stringify(result);
  const { statusCode, body } = await requestRaw(
    socketPath,
    path,
    "POST",
    payload,
    timeoutMs,
  );
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      `postSpawnResult: status ${statusCode} from ${path}: ${body}`,
    );
  }
}

/**
 * Generic POST helper for session-lifecycle event routes (D-07):
 *   - /v1/event/session-end
 *   - /v1/event/agent-end
 *   - /v1/event/before-compaction
 *   - /v1/event/message-received
 *
 * Tests use this to drive the selective-forwarding hooks that Wave 3 mounts.
 */
export async function postEvent(
  socketPath: string,
  path: string,
  body: unknown,
  timeoutMs = 10_000,
): Promise<{ statusCode: number; body: unknown }> {
  const payload = JSON.stringify(body);
  const { statusCode, body: respBody } = await requestRaw(
    socketPath,
    path,
    "POST",
    payload,
    timeoutMs,
  );
  return { statusCode, body: parseJsonSafe(respBody) };
}
