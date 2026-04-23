/**
 * Mount IPC (/v1/*) routes onto an existing http.Server.
 *
 * Called by `startAofDaemon` after `createHealthServer`. Leaves `/healthz`
 * and `/status` untouched — this module only handles `/v1/*`.
 *
 * Pitfall 1 (43-RESEARCH.md §Common Pitfalls): Node's default
 * `server.keepAliveTimeout` (5s) will close idle sockets mid-response,
 * which matters once Wave 2 adds long-poll routes. Set it to 60s here so
 * the setting lives next to the code that relies on it. `headersTimeout`
 * must be slightly greater than `keepAliveTimeout`.
 *
 * @module ipc/server-attach
 */

import type { Server } from "node:http";
import type { IpcDeps } from "./types.js";
import { handleInvokeTool } from "./routes/invoke-tool.js";
import {
  handleSessionEnd,
  handleAgentEnd,
  handleBeforeCompaction,
  handleMessageReceived,
} from "./routes/session-events.js";
import { handleSpawnWait } from "./routes/spawn-wait.js";
import { handleSpawnResult } from "./routes/spawn-result.js";
import { handleDeliveryWait } from "./routes/delivery-wait.js";
import { handleDeliveryResult } from "./routes/delivery-result.js";

export function attachIpcRoutes(server: Server, deps: IpcDeps): void {
  // Long-poll safety (Pitfall 1): Node default keepAliveTimeout is 5s, which
  // would reap the TCP socket mid-response once Wave 2 adds long-poll routes.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 61_000;

  // Known routes, keyed by URL. Method is validated by the handler itself
  // so GET on a POST-only route returns 405 (not 404).
  const routes: Record<string, import("./types.js").RouteHandler> = {
    "/v1/tool/invoke": handleInvokeTool,
    "/v1/event/session-end": handleSessionEnd,
    "/v1/event/agent-end": handleAgentEnd,
    "/v1/event/before-compaction": handleBeforeCompaction,
    "/v1/event/message-received": handleMessageReceived,
    "/v1/spawns/wait": handleSpawnWait,
    "/v1/deliveries/wait": handleDeliveryWait,
    // `/v1/spawns/{id}/result` + `/v1/deliveries/{id}/result` matched via regex below.
  };

  /**
   * Parametric routes whose URL contains a path segment that can't be used as
   * a map key. Each entry's regex must match the full URL; the handler parses
   * the id out of `req.url` itself (single source of truth).
   */
  const patternRoutes: Array<{
    re: RegExp;
    handler: import("./types.js").RouteHandler;
  }> = [
    { re: /^\/v1\/spawns\/[^/]+\/result$/, handler: handleSpawnResult },
    { re: /^\/v1\/deliveries\/[^/]+\/result$/, handler: handleDeliveryResult },
  ];

  server.on("request", (req, res) => {
    // Let /healthz, /status, etc. fall through to the existing handler.
    if (!req.url?.startsWith("/v1/")) return;

    void (async () => {
      try {
        const handler = routes[req.url!];
        if (handler) {
          await handler(req, res, deps);
          return;
        }

        for (const { re, handler: h } of patternRoutes) {
          if (re.test(req.url!)) {
            await h(req, res, deps);
            return;
          }
        }

        if (!res.headersSent) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                kind: "not-found",
                message: `no route: ${req.method} ${req.url}`,
              },
            }),
          );
        }
      } catch (err) {
        deps.log.error({ err, url: req.url }, "IPC route threw");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                kind: "internal",
                message: err instanceof Error ? err.message : String(err),
              },
            }),
          );
        }
      }
    })();
  });
}
