/**
 * POST /v1/deliveries/{id}/result — plugin posts chat-delivery outcome.
 *
 * The plugin invokes this route after attempting the OpenClaw outbound send
 * (success, failure, or exception). The id in the URL path matches
 * `ChatDeliveryRequest.id` delivered via `GET /v1/deliveries/wait`.
 *
 * Delivery is performed via `deps.deliverChatResult(id, result)` — the daemon
 * wires this to `ChatDeliveryQueue.deliverResult`, which resolves/rejects the
 * promise the enqueuing `MatrixMessageTool.send()` is awaiting. Idempotent:
 * a second POST with the same id is a no-op (the first settles the waiter
 * and the id is then unknown).
 *
 * @module ipc/routes/delivery-result
 */

import type { RouteHandler } from "../types.js";
import { ChatDeliveryResultPost, type IpcError } from "../schemas.js";
import {
  readBody,
  sendJson,
  sendError,
  PayloadTooLargeError,
} from "../http-utils.js";

const PATH_RE = /^\/v1\/deliveries\/([^/]+)\/result$/;

export const handleDeliveryResult: RouteHandler = async (req, res, deps) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(
      JSON.stringify({
        error: { kind: "validation", message: "method not allowed" },
      }),
    );
    return;
  }

  const match = PATH_RE.exec(req.url ?? "");
  if (!match) {
    sendError(res, {
      kind: "not-found",
      message: `invalid delivery-result path: ${req.url ?? "<unknown>"}`,
    });
    return;
  }
  const id = decodeURIComponent(match[1]!);

  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      const e: IpcError = { kind: "validation", message: err.message };
      sendJson(res, 413, { error: e });
      return;
    }
    deps.log.error({ err, id }, "failed to read delivery-result body");
    sendError(res, {
      kind: "internal",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(bodyText);
  } catch {
    sendError(res, { kind: "validation", message: "invalid JSON" });
    return;
  }

  const parsed = ChatDeliveryResultPost.safeParse(rawJson);
  if (!parsed.success) {
    sendError(res, {
      kind: "validation",
      message: "invalid delivery-result envelope",
      details: { issues: parsed.error.issues },
    });
    return;
  }

  if (!deps.deliverChatResult) {
    sendError(res, {
      kind: "unavailable",
      message: "chat-delivery result wiring not available (daemon starting up)",
    });
    return;
  }

  try {
    deps.deliverChatResult(id, parsed.data);
  } catch (err) {
    deps.log.error({ err, id }, "deliverChatResult threw");
    sendError(res, {
      kind: "internal",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  sendJson(res, 200, { ok: true });
};
