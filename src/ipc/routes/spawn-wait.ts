/**
 * GET /v1/spawns/wait — long-poll spawn dispatch (D-09).
 *
 * The attached plugin long-polls this route. On success, returns 200 with a
 * {@link SpawnRequest} body. When the server-side keepalive window elapses
 * with no work, returns 204 so the plugin can reconnect immediately (no TCP
 * idle-timeout race).
 *
 * Registers the connection with {@link PluginRegistry} on entry — a live
 * long-poll IS a registered plugin (D-11 implicit registration). Auto-release
 * is wired by `PluginRegistry.register()` via `res.on("close")`.
 *
 * Pitfall 2 (Research §Common Pitfalls): listeners must not leak. A single
 * `settled` flag guards the three race paths (claim-on-enqueue, keepalive
 * timeout, connection drop); each one clears the timer and removes the
 * `"enqueue"` listener exactly once.
 *
 * Keepalive window: 25s. Clients must use a request timeout >25s (the plugin
 * side uses 30s via `AbortSignal.timeout`). Research §Keepalive Calibration
 * confirms this pairing against Node 22's `keepAliveTimeout` default.
 *
 * @module ipc/routes/spawn-wait
 */

import type { RouteHandler } from "../types.js";
import type { SpawnRequest } from "../schemas.js";
import { sendJson, sendError } from "../http-utils.js";

/** Server-side hold window before returning 204. See Research §Keepalive Calibration. */
const KEEPALIVE_MS = 25_000;

export const handleSpawnWait: RouteHandler = async (req, res, deps) => {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "GET" });
    res.end(
      JSON.stringify({
        error: { kind: "validation", message: "method not allowed" },
      }),
    );
    return;
  }

  if (!deps.spawnQueue || !deps.pluginRegistry) {
    sendError(res, {
      kind: "unavailable",
      message: "spawn queue not wired (daemon starting up)",
    });
    return;
  }

  const queue = deps.spawnQueue;
  const registry = deps.pluginRegistry;

  // D-11 implicit registration — an active long-poll IS a registered plugin.
  // The handle auto-releases on res.on("close") inside PluginRegistry.register.
  registry.register(req, res);

  // Fast path: if the queue already has work, drain a request immediately.
  const claimant = queue.claim();
  if (claimant) {
    sendJson(res, 200, claimant);
    return;
  }

  // Slow path: no work yet. Race three outcomes via a single `settled` guard.
  let settled = false;

  const cleanup = (): void => {
    clearTimeout(timer);
    queue.off("enqueue", onEnqueue);
  };

  const onEnqueue = (sr: SpawnRequest): void => {
    if (settled) return;
    // Another long-poll may have claimed this id first — tryClaim is atomic.
    if (!queue.tryClaim(sr.id)) return;
    settled = true;
    cleanup();
    sendJson(res, 200, sr);
  };

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    res.writeHead(204);
    res.end();
  }, KEEPALIVE_MS);

  res.on("close", () => {
    if (settled) return;
    settled = true;
    cleanup();
    // Nothing claimed — no queue mutation needed.
  });

  queue.on("enqueue", onEnqueue);
};
