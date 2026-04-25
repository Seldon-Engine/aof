/**
 * POST /v1/tool/invoke — the single tool-invocation envelope.
 *
 * Body shape: {@link InvokeToolRequest}. Parsed, dispatched against the
 * shared `toolRegistry`, and returned as `{ result }` or `{ error }`.
 *
 * Error classification rules (kind → HTTP status):
 *   - validation (envelope or inner-params Zod failure) → 400
 *   - not-found (tool name unknown)                    → 404
 *   - permission (PermissionAwareTaskStore denial)     → 403
 *   - unavailable (daemon shutting down)               → 503
 *   - internal (anything else)                         → 500
 *
 * @module ipc/routes/invoke-tool
 */

import type { RouteHandler } from "../types.js";
import type { ToolContext } from "../../tools/types.js";
import { InvokeToolRequest, type IpcError } from "../schemas.js";
import {
  readBody,
  sendJson,
  sendError,
  classifyError,
  httpStatusForKind,
  PayloadTooLargeError,
} from "../http-utils.js";
import { getLivenessStatus } from "../../daemon/health.js";
import { getConfig } from "../../config/registry.js";
import { join } from "node:path";
import { ContextInterfaceRegistry } from "../../context/registry.js";

/**
 * Cached daemon-side registry + skillsDir (Open Q3 resolution).
 *
 * `aof_context_load` reads `(ctx as any)._contextRegistry` and
 * `(ctx as any)._skillsDir` — adapter-provided extras not in the base
 * `ToolContext`. On the daemon side we stand up a single shared registry
 * and point skillsDir at `<dataDir>/skills` so the route can satisfy the
 * contract without plugin involvement.
 */
let cachedContextRegistry: ContextInterfaceRegistry | undefined;
function getContextRegistry(): ContextInterfaceRegistry {
  if (!cachedContextRegistry) cachedContextRegistry = new ContextInterfaceRegistry();
  return cachedContextRegistry;
}

function getSkillsDir(): string {
  const cfg = getConfig();
  return join(cfg.core.dataDir, "skills");
}

export const handleInvokeTool: RouteHandler = async (req, res, deps) => {
  // --- Method check ---
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(
      JSON.stringify({
        error: { kind: "validation", message: "method not allowed" },
      }),
    );
    return;
  }

  // --- Shutdown gate (T-43-06 / availability) ---
  if (getLivenessStatus().status === "error") {
    const e: IpcError = { kind: "unavailable", message: "daemon is shutting down" };
    sendError(res, e);
    return;
  }

  // --- Body ---
  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      const e: IpcError = { kind: "validation", message: err.message };
      sendJson(res, 413, { error: e });
      return;
    }
    deps.log.error({ err }, "failed to read IPC body");
    const e: IpcError = { kind: "internal", message: "failed to read body" };
    sendError(res, e);
    return;
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(bodyText);
  } catch {
    const e: IpcError = { kind: "validation", message: "invalid JSON" };
    sendError(res, e);
    return;
  }

  // --- Envelope parse ---
  const envelope = InvokeToolRequest.safeParse(rawJson);
  if (!envelope.success) {
    const e: IpcError = {
      kind: "validation",
      message: "invalid envelope",
      details: { issues: envelope.error.issues },
    };
    sendError(res, e);
    return;
  }
  const { name, params, actor, projectId, toolCallId, correlationId } = envelope.data;

  // --- Tool lookup ---
  const def = deps.toolRegistry[name];
  if (!def) {
    const e: IpcError = {
      kind: "not-found",
      message: `tool "${name}" not registered`,
    };
    sendError(res, e);
    return;
  }

  // --- Inner params parse (tool-specific schema is source of truth) ---
  const inner = def.schema.safeParse(params);
  if (!inner.success) {
    const e: IpcError = {
      kind: "validation",
      message: `invalid params for ${name}`,
      details: { issues: inner.error.issues },
    };
    sendError(res, e);
    return;
  }

  // --- Store resolution (project-scoped + permission-aware) ---
  let store;
  try {
    store = await deps.resolveStore({ actor, projectId });
  } catch (err) {
    const kind = classifyError(err);
    const e: IpcError = {
      kind,
      message: err instanceof Error ? err.message : String(err),
    };
    sendJson(res, httpStatusForKind(kind), { error: e });
    return;
  }

  // --- Build tool context ---
  const ctx: ToolContext & {
    _contextRegistry?: ContextInterfaceRegistry;
    _skillsDir?: string;
  } = {
    store,
    logger: deps.logger,
    // BUG-044: ToolContext.projectId is `string | undefined`; an
    // unscoped base store reports `projectId === null` and must
    // coerce to `undefined` here.
    projectId: projectId ?? store.projectId ?? undefined,
    // aof_context_load needs these adapter-extras; daemon provides them for
    // the single built-in registry + <dataDir>/skills path (Open Q3).
    _contextRegistry: getContextRegistry(),
    _skillsDir: getSkillsDir(),
  };

  // --- Dispatch ---
  // Phase 46 / Bug 2C: inject envelope.actor into inner.data when the
  // caller didn't supply one. Closes the createdBy: "unknown" gap on
  // plugin-originated aof_dispatch — the OpenClaw plugin sets envelope.actor
  // from the invocation context, but the daemon-side route never
  // propagated it down to the handler input, so the handler's
  // `input.actor ?? "unknown"` fallback always won.
  //
  // Precedence: explicit params.actor (caller-supplied) > envelope.actor
  // (authenticated IPC identity) > handler default ("unknown" for
  // aof_dispatch, "mcp" for MCP path). MCP path is unaffected because
  // MCP constructs its own envelope with its own `actor: "mcp"`.
  const enrichedParams: typeof inner.data =
    actor && (inner.data as { actor?: string }).actor === undefined
      ? ({ ...(inner.data as Record<string, unknown>), actor } as typeof inner.data)
      : inner.data;
  try {
    const result = await def.handler(ctx, enrichedParams);
    sendJson(res, 200, { result });
  } catch (err) {
    const kind = classifyError(err);
    const message = err instanceof Error ? err.message : String(err);

    // Explicit branches for the documented kinds — matches the error taxonomy
    // in the module docstring and makes classification visible to code search.
    if (kind === "permission") {
      const e: IpcError = { kind: "permission", message };
      sendJson(res, httpStatusForKind(kind), { error: e });
      return;
    }
    if (kind === "not-found") {
      const e: IpcError = { kind: "not-found", message };
      sendJson(res, httpStatusForKind(kind), { error: e });
      return;
    }

    // Log only 500-class failures — 4xx outcomes are caller errors, not daemon faults.
    if (kind === "internal") {
      deps.log.error(
        { err, name, toolCallId, correlationId },
        "tool handler failed",
      );
    }
    const e: IpcError = { kind: "internal", message };
    sendJson(res, httpStatusForKind("internal"), { error: e });
  }
};
