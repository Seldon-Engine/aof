import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { unlinkSync, existsSync } from "node:fs";
import type { ITaskStore } from "../store/interfaces.js";
import { getHealthStatus, getLivenessStatus, type DaemonState, type DaemonStatusContext } from "./health.js";

export type DaemonStateProvider = () => DaemonState;
export type StatusContextProvider = () => DaemonStatusContext;

/**
 * Create and start an HTTP server on a Unix domain socket with
 * /healthz (liveness) and /status (full status) routes.
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

    // Unknown route
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(socketPath);
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
