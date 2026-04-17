/**
 * Session lifecycle event forwarders (D-07 + A1 amendment — 4 hooks).
 *
 * Each handler accepts a POST, parses the event envelope, triggers the
 * corresponding `AOFService` handler fire-and-forget, and responds 200.
 *
 * Routes:
 *   POST /v1/event/session-end       → service.handleSessionEnd()
 *   POST /v1/event/agent-end         → service.handleAgentEnd(event)
 *   POST /v1/event/before-compaction → service.handleSessionEnd()   (piggyback)
 *   POST /v1/event/message-received  → service.handleMessageReceived(event)
 *
 * All handlers are stateless; the "truth" is the AOFService's internal state.
 *
 * @module ipc/routes/session-events
 */

import type { RouteHandler } from "../types.js";
import {
  SessionEndEvent,
  AgentEndEvent,
  BeforeCompactionEvent,
  MessageReceivedEvent,
  type IpcError,
} from "../schemas.js";
import {
  readBody,
  sendJson,
  sendError,
  PayloadTooLargeError,
} from "../http-utils.js";

async function parseEventBody(
  req: Parameters<RouteHandler>[0],
): Promise<{ ok: true; value: unknown } | { ok: false; error: IpcError; status?: number }> {
  let text: string;
  try {
    text = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return {
        ok: false,
        status: 413,
        error: { kind: "validation", message: err.message },
      };
    }
    return {
      ok: false,
      error: {
        kind: "internal",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      error: { kind: "validation", message: "invalid JSON" },
    };
  }
}

function rejectNonPost(
  req: Parameters<RouteHandler>[0],
  res: Parameters<RouteHandler>[1],
): boolean {
  if (req.method === "POST") return false;
  res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
  res.end(
    JSON.stringify({
      error: { kind: "validation", message: "method not allowed" },
    }),
  );
  return true;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const handleSessionEnd: RouteHandler = async (req, res, deps) => {
  if (rejectNonPost(req, res)) return;
  const body = await parseEventBody(req);
  if (!body.ok) {
    sendJson(res, body.status ?? 400, { error: body.error });
    return;
  }
  const parsed = SessionEndEvent.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, {
      kind: "validation",
      message: "invalid session_end event",
      details: { issues: parsed.error.issues },
    });
    return;
  }
  // Fire-and-forget — do not block the caller on internal poll work.
  void deps.service
    .handleSessionEnd(parsed.data)
    .catch((err) => deps.log.error({ err }, "handleSessionEnd failed"));
  sendJson(res, 200, { ok: true });
};

export const handleAgentEnd: RouteHandler = async (req, res, deps) => {
  if (rejectNonPost(req, res)) return;
  const body = await parseEventBody(req);
  if (!body.ok) {
    sendJson(res, body.status ?? 400, { error: body.error });
    return;
  }
  const parsed = AgentEndEvent.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, {
      kind: "validation",
      message: "invalid agent_end event",
      details: { issues: parsed.error.issues },
    });
    return;
  }
  void deps.service
    .handleAgentEnd(parsed.data)
    .catch((err) => deps.log.error({ err }, "handleAgentEnd failed"));
  sendJson(res, 200, { ok: true });
};

export const handleBeforeCompaction: RouteHandler = async (req, res, deps) => {
  if (rejectNonPost(req, res)) return;
  const body = await parseEventBody(req);
  if (!body.ok) {
    sendJson(res, body.status ?? 400, { error: body.error });
    return;
  }
  const parsed = BeforeCompactionEvent.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, {
      kind: "validation",
      message: "invalid before_compaction event",
      details: { issues: parsed.error.issues },
    });
    return;
  }
  // Piggyback on handleSessionEnd — CONTEXT.md: before_compaction was the
  // stand-in trigger pre-43 when a session was about to be garbage-collected.
  void deps.service
    .handleSessionEnd(parsed.data)
    .catch((err) => deps.log.error({ err }, "handleBeforeCompaction failed"));
  sendJson(res, 200, { ok: true });
};

export const handleMessageReceived: RouteHandler = async (req, res, deps) => {
  if (rejectNonPost(req, res)) return;
  const body = await parseEventBody(req);
  if (!body.ok) {
    sendJson(res, body.status ?? 400, { error: body.error });
    return;
  }
  const parsed = MessageReceivedEvent.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, {
      kind: "validation",
      message: "invalid message_received event",
      details: { issues: parsed.error.issues },
    });
    return;
  }
  // A1 resolution: message_received IS state-mutating on the daemon side
  // (protocolRouter.route()); forward it and trigger a poll.
  void deps.service
    .handleMessageReceived(parsed.data)
    .catch((err) => deps.log.error({ err }, "handleMessageReceived failed"));
  sendJson(res, 200, { ok: true });
};
