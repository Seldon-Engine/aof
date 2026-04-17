/**
 * DaemonIpcClient — plugin-side Unix-socket RPC client for the AOF daemon.
 *
 * Talks to the same `daemon.sock` that hosts `/healthz` + `/status`, extending
 * the contract with Phase 43's `/v1/*` routes (D-05, D-06, D-09):
 *
 *   - POST /v1/tool/invoke        — single envelope for every tool call (D-06)
 *   - GET  /v1/spawns/wait        — long-poll for SpawnRequest (D-09, 200|204)
 *   - POST /v1/spawns/:id/result  — post SpawnResultPost (D-09)
 *   - POST /v1/event/session-end
 *   - POST /v1/event/agent-end
 *   - POST /v1/event/before-compaction
 *   - POST /v1/event/message-received   (A1 — protocolRouter.route mutates daemon-owned state)
 *   - GET  /healthz                (reused for readiness self-check)
 *
 * Transport is `node:http` `request({ socketPath })` rather than `fetch` —
 * Pitfall 4 in 43-RESEARCH.md: `AbortSignal.timeout` over a Unix socket fetch
 * is unreliable on some Node builds, and `http.request` gives us a clean
 * `timeout` option.
 *
 * The module exposes `ensureDaemonIpcClient` as a module-level singleton gate
 * (Pitfall 3) — OpenClaw reloads the AOF plugin on every agent session, but
 * module state persists across those reloads so this keeps us from churning
 * clients and, more importantly, double-starting the spawn-poller.
 *
 * @module openclaw/daemon-ipc-client
 */

import { request as httpRequest } from "node:http";
import { createLogger } from "../logging/index.js";
import type {
  InvokeToolRequest,
  InvokeToolResponse,
  SpawnRequest,
  SpawnResultPost,
} from "../ipc/schemas.js";
import {
  InvokeToolResponse as InvokeToolResponseSchema,
  SpawnRequest as SpawnRequestSchema,
} from "../ipc/schemas.js";

const log = createLogger("plugin-bridge");

/** Raw `{ statusCode, body }` pair returned by the internal HTTP helpers. */
interface RawResponse {
  statusCode: number;
  body: string;
}

/**
 * Plugin-side IPC client — one instance per daemon socket.
 *
 * Instances are cheap to construct (no connection is opened until a method is
 * called). Prefer `ensureDaemonIpcClient` to keep a single instance alive
 * across OpenClaw per-session plugin reloads.
 */
export class DaemonIpcClient {
  constructor(private readonly _socketPath: string) {}

  /** The absolute path to `daemon.sock` this client is bound to. */
  get socketPath(): string {
    return this._socketPath;
  }

  /**
   * POST /v1/tool/invoke — D-06 single envelope.
   *
   * Returns the parsed `InvokeToolResponse` envelope regardless of HTTP status
   * — the daemon surfaces failures as `{ error }` envelopes with meaningful
   * `IpcErrorKind`, and the plugin must forward those to the caller rather
   * than throw. Genuine transport failures (socket gone, timeout, non-JSON
   * body) still reject.
   */
  async invokeTool(envelope: InvokeToolRequest, timeoutMs = 30_000): Promise<InvokeToolResponse> {
    const raw = await this.postRaw("/v1/tool/invoke", envelope, timeoutMs);
    return this.parseInvokeToolResponse(raw);
  }

  /**
   * GET /v1/spawns/wait — D-09 long-poll.
   *
   * Returns `undefined` on HTTP 204 (server keepalive fired — caller should
   * reconnect immediately), or a parsed `SpawnRequest` on HTTP 200. Any other
   * status rejects. Client timeout is set slightly higher than the server's
   * 25s keepalive so the server always fires its 204 first.
   */
  async waitForSpawn(timeoutMs = 30_000): Promise<SpawnRequest | undefined> {
    const { statusCode, body } = await this.getRaw("/v1/spawns/wait", timeoutMs + 5_000);
    if (statusCode === 204) return undefined;
    if (statusCode === 200) {
      return SpawnRequestSchema.parse(JSON.parse(body));
    }
    throw new Error(`unexpected long-poll status ${statusCode}: ${body.slice(0, 200)}`);
  }

  /** POST /v1/spawns/:id/result — D-09 outcome delivery. */
  async postSpawnResult(id: string, result: SpawnResultPost): Promise<void> {
    const { statusCode, body } = await this.postRaw(
      `/v1/spawns/${encodeURIComponent(id)}/result`,
      result,
      10_000,
    );
    this.requireSuccess(statusCode, body, `POST /v1/spawns/${id}/result`);
  }

  /** POST /v1/event/session-end — D-07 forward. */
  async postSessionEnd(event: unknown): Promise<void> {
    await this.postEvent("/v1/event/session-end", event);
  }

  /** POST /v1/event/agent-end — D-07 forward. */
  async postAgentEnd(event: unknown): Promise<void> {
    await this.postEvent("/v1/event/agent-end", event);
  }

  /** POST /v1/event/before-compaction — D-07 forward. */
  async postBeforeCompaction(event?: unknown): Promise<void> {
    await this.postEvent("/v1/event/before-compaction", event ?? {});
  }

  /**
   * POST /v1/event/message-received — D-07 A1 amendment.
   *
   * Forwarded because `handleMessageReceived` invokes `protocolRouter.route()`
   * on the daemon side, which mutates daemon-owned session routing state.
   */
  async postMessageReceived(event: unknown): Promise<void> {
    await this.postEvent("/v1/event/message-received", event);
  }

  /**
   * GET /healthz — readiness probe.
   *
   * Mirrors the canonical `src/daemon/server.ts::selfCheck` helper but bound
   * to this client's socketPath.
   */
  async selfCheck(timeoutMs = 2_000): Promise<boolean> {
    return new Promise((resolve) => {
      const req = httpRequest(
        { socketPath: this._socketPath, path: "/healthz", method: "GET", timeout: timeoutMs },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async postEvent(path: string, event: unknown): Promise<void> {
    const { statusCode, body } = await this.postRaw(path, event ?? {}, 5_000);
    this.requireSuccess(statusCode, body, `POST ${path}`);
  }

  /**
   * Parse an `/v1/tool/invoke` response. The daemon's `{ result }`/`{ error }`
   * union covers both success and failure at the envelope layer — a 2xx carries
   * a `result` envelope, a 4xx/5xx carries an `error` envelope. We return both
   * as an `InvokeToolResponse`; only genuine transport faults throw.
   */
  private parseInvokeToolResponse(raw: RawResponse): InvokeToolResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.body);
    } catch (err) {
      throw new Error(
        `invokeTool: non-JSON response from daemon (HTTP ${raw.statusCode}): ${raw.body.slice(0, 200)}`,
        { cause: err as Error },
      );
    }
    const result = InvokeToolResponseSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `invokeTool: daemon response did not match InvokeToolResponse (HTTP ${raw.statusCode}): ${result.error.message}`,
      );
    }
    return result.data;
  }

  private requireSuccess(statusCode: number, body: string, context: string): void {
    if (statusCode >= 200 && statusCode < 300) return;
    throw new Error(`${context} failed: HTTP ${statusCode}: ${body.slice(0, 200)}`);
  }

  private postRaw(path: string, body: unknown, timeoutMs: number): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = httpRequest(
        {
          socketPath: this._socketPath,
          path,
          method: "POST",
          timeout: timeoutMs,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload).toString(),
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
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
      req.write(payload);
      req.end();
    });
  }

  private getRaw(path: string, timeoutMs: number): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { socketPath: this._socketPath, path, method: "GET", timeout: timeoutMs },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
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
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (Pitfall 3 — OpenClaw per-session plugin reload)
// ---------------------------------------------------------------------------

let cachedClient: DaemonIpcClient | null = null;

/**
 * Return a module-level `DaemonIpcClient` keyed by `socketPath`. If a client
 * already exists for the same socket, it is returned verbatim; otherwise a
 * fresh one is constructed and cached.
 *
 * The cache survives OpenClaw's per-agent-session plugin reload cycle because
 * ESM module state is shared across those reloads — the same survival trick
 * the legacy `schedulerService` singleton (now being removed in 43-07) relied
 * on.
 */
export function ensureDaemonIpcClient(opts: { socketPath: string }): DaemonIpcClient {
  if (cachedClient && cachedClient.socketPath === opts.socketPath) {
    return cachedClient;
  }
  cachedClient = new DaemonIpcClient(opts.socketPath);
  log.info({ socketPath: opts.socketPath }, "DaemonIpcClient singleton initialized");
  return cachedClient;
}

/**
 * Clear the cached client — test-only helper so individual tests can start
 * from a clean slate without polluting other tests in the same run.
 */
export function resetDaemonIpcClient(): void {
  cachedClient = null;
}
