import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { unlinkSync, existsSync, chmodSync } from "node:fs";
import type { ITaskStore } from "../store/interfaces.js";
import { getHealthStatus, getLivenessStatus, type DaemonState, type DaemonStatusContext } from "./health.js";

export type DaemonStateProvider = () => DaemonState;
export type StatusContextProvider = () => DaemonStatusContext;

/**
 * Create and start an HTTP server on a Unix domain socket with
 * /healthz (liveness) and /status (full status) routes.
 *
 * The daemon attaches additional `/v1/*` IPC routes onto the same server
 * via `attachIpcRoutes` in `src/ipc/server-attach.ts`. That function is
 * responsible for `keepAliveTimeout` / `headersTimeout` tuning (long-poll
 * safety, Pitfall 1 in 43-RESEARCH.md).
 */
export function createHealthServer(
  getState: DaemonStateProvider,
  store: ITaskStore,
  socketPath: string,
  getContext?: StatusContextProvider,
): Server {
  // Remove stale socket file from a previous crash
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  } catch {
    // Ignore — socket may not exist or may already be removed
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/healthz") {
      const liveness = getLivenessStatus();
      const httpStatus = liveness.status === "ok" ? 200 : 503;
      res.writeHead(httpStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(liveness));
      return;
    }

    if (req.method === "GET" && req.url === "/status") {
      try {
        const state = getState();
        const context = getContext?.();
        const health = await getHealthStatus(state, store, context);
        const httpStatus = health.status === "healthy" ? 200 : 503;

        res.writeHead(httpStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
      } catch (err) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "unhealthy",
          error: (err as Error).message,
        }));
      }
      return;
    }

    // `/v1/*` is handled by attachIpcRoutes (mounted post-construction by
    // startAofDaemon). Fall through without writing a response so the IPC
    // listener can reply; otherwise the double-listener race would send a
    // premature 404.
    if (req.url?.startsWith("/v1/")) return;

    // Unknown route
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(socketPath, () => {
    // T-43-01: daemon.sock must be 0600 so only the invoking user can connect.
    // Node's default is the process umask applied to 0o666, which typically
    // yields 0o755 — we explicitly chmod here. Errors are best-effort logged
    // by the caller's `listening` handler if needed; chmodSync failing would
    // be a genuine fault surfaced via the self-check.
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // If chmod fails the self-check will still succeed (socket is alive);
      // the test asserting 0600 will fail loudly, which is the right signal.
    }
  });
  return server;
}

/**
 * Self-check: make a GET /healthz request to the Unix socket.
 * Returns true if the server responds with 200, false otherwise.
 */
export function selfCheck(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        socketPath,
        path: "/healthz",
        method: "GET",
        timeout: 2000,
      },
      (res) => {
        // Consume the response body to free the socket
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
