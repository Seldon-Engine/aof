/**
 * Gateway-facing /aof/status + /aof/metrics handler that proxies to the
 * daemon's /status endpoint over the Unix socket (Open Q4 — preserves the
 * pre-Phase-43 gateway URL contract without duplicating state in the plugin).
 *
 * @module openclaw/status-proxy
 */

import { request as httpRequest } from "node:http";
import type { GatewayHandler } from "../gateway/handlers.js";

/** Build a GatewayHandler that GETs /status on the daemon socket. */
export function buildStatusProxyHandler(socketPath: string): GatewayHandler {
  return async () =>
    new Promise((resolve) => {
      const req = httpRequest(
        { socketPath, path: "/status", method: "GET", timeout: 5_000 },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            data += c;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 502,
              headers: { "Content-Type": "application/json" },
              body: data || "{}",
            }),
          );
        },
      );
      req.on("error", (err) =>
        resolve({
          status: 502,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: { kind: "unavailable", message: err.message } }),
        }),
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({
          status: 504,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: { kind: "timeout", message: "daemon /status timeout" } }),
        });
      });
      req.end();
    });
}
