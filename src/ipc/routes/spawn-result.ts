/**
 * POST /v1/spawns/{id}/result — plugin posts spawn outcome (D-09).
 *
 * The plugin invokes this route after `runEmbeddedPiAgent` completes (success,
 * failure, or abort). The id in the URL path matches the `SpawnRequest.id`
 * that was delivered via `GET /v1/spawns/wait`.
 *
 * Delivery is performed via `deps.deliverSpawnResult(id, result)` — the daemon
 * wires this to `PluginBridgeAdapter.deliverResult()`, which owns the
 * `spawnId → { taskId, onRunComplete }` map and fires the dispatch-pipeline
 * callback.
 *
 * T-43-04 tampering/replay mitigation: the adapter's internal map DELETES the
 * entry after the first delivery, so a second POST with the same id is a
 * no-op (idempotent-by-side-effect). ids are server-generated via
 * `randomUUID()` — not forgeable from outside same-uid trust.
 *
 * @module ipc/routes/spawn-result
 */

import type { RouteHandler } from "../types.js";
import { SpawnResultPost, type IpcError } from "../schemas.js";
import {
  readBody,
  sendJson,
  sendError,
  PayloadTooLargeError,
} from "../http-utils.js";

const PATH_RE = /^\/v1\/spawns\/([^/]+)\/result$/;

export const handleSpawnResult: RouteHandler = async (req, res, deps) => {
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
      message: `invalid spawn-result path: ${req.url ?? "<unknown>"}`,
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
    deps.log.error({ err, id }, "failed to read spawn-result body");
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

  const parsed = SpawnResultPost.safeParse(rawJson);
  if (!parsed.success) {
    sendError(res, {
      kind: "validation",
      message: "invalid spawn-result envelope",
      details: { issues: parsed.error.issues },
    });
    return;
  }

  if (!deps.deliverSpawnResult) {
    sendError(res, {
      kind: "unavailable",
      message: "spawn-result delivery not wired (daemon starting up)",
    });
    return;
  }

  try {
    await deps.deliverSpawnResult(id, parsed.data);
  } catch (err) {
    deps.log.error({ err, id }, "deliverSpawnResult threw");
    sendError(res, {
      kind: "internal",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  sendJson(res, 200, { ok: true });
};
