/**
 * GET /v1/deliveries/wait — long-poll chat-delivery dispatch.
 *
 * The attached plugin long-polls this route. On success, returns 200 with a
 * {@link ChatDeliveryRequest} body. When the server-side keepalive window
 * elapses with no work, returns 204 so the plugin can reconnect immediately
 * (no TCP idle-timeout race). Mirrors `spawn-wait.ts` — same race-paths,
 * same single `settled` guard, same keepalive window.
 *
 * @module ipc/routes/delivery-wait
 */

import type { RouteHandler } from "../types.js";
import type { ChatDeliveryRequest } from "../schemas.js";
import { sendJson, sendError } from "../http-utils.js";

const KEEPALIVE_MS = 25_000;

export const handleDeliveryWait: RouteHandler = async (req, res, deps) => {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "GET" });
    res.end(
      JSON.stringify({
        error: { kind: "validation", message: "method not allowed" },
      }),
    );
    return;
  }

  if (!deps.chatDeliveryQueue) {
    sendError(res, {
      kind: "unavailable",
      message: "chat-delivery queue not wired (daemon starting up)",
    });
    return;
  }

  const queue = deps.chatDeliveryQueue;

  // Fast path: if the queue already has work, drain a request immediately.
  const claimant = queue.claim();
  if (claimant) {
    sendJson(res, 200, claimant);
    return;
  }

  let settled = false;

  const cleanup = (): void => {
    clearTimeout(timer);
    queue.off("enqueue", onEnqueue);
  };

  const onEnqueue = (req: ChatDeliveryRequest): void => {
    if (settled) return;
    if (!queue.tryClaim(req.id)) return;
    settled = true;
    cleanup();
    sendJson(res, 200, req);
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
  });

  queue.on("enqueue", onEnqueue);
};
