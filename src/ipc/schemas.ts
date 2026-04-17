/**
 * IPC envelope Zod schemas for daemon ↔ plugin communication.
 *
 * These schemas are the source of truth for the wire-level contract.
 * - `InvokeToolRequest` / `InvokeToolResponse` / `IpcError` describe the
 *   POST /v1/tool/invoke round-trip (D-06).
 * - `SpawnRequest` / `SpawnResultPost` describe the long-poll spawn callback
 *   protocol (D-09, wired in Wave 2).
 * - `SessionEndEvent` / `AgentEndEvent` / `BeforeCompactionEvent` /
 *   `MessageReceivedEvent` describe the selective event forwarding hooks
 *   (D-07, A1-amended to 4 forwards).
 *
 * `.strict()` on `InvokeToolRequest` rejects unknown envelope fields.
 * Inner `params` uses `z.record(z.string(), z.unknown())` — the tool-specific
 * schema is source of truth, validated server-side via `toolRegistry[name].schema`.
 *
 * `callbackDepth` is carried in the envelope (and in `SpawnRequest`) rather
 * than via the `AOF_CALLBACK_DEPTH` env mutation — CLAUDE.md constrains env
 * usage to the legacy in-process path only.
 *
 * @module ipc/schemas
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// InvokeTool — POST /v1/tool/invoke (D-06)
// ---------------------------------------------------------------------------

/**
 * Envelope for a plugin-initiated tool invocation.
 * `pluginId` defaults to "openclaw" (D-13 — reserved for multi-plugin fan-out).
 * `toolCallId` threads the gateway's tool-call identifier through to the
 * handler so that notification capture (`mergeDispatchNotificationRecipient`)
 * can line up its side-channel state.
 */
export const InvokeToolRequest = z
  .object({
    pluginId: z.string().default("openclaw"),
    name: z.string(),
    params: z.record(z.string(), z.unknown()),
    actor: z.string().optional(),
    projectId: z.string().optional(),
    correlationId: z.string().optional(),
    toolCallId: z.string(),
    callbackDepth: z.number().int().nonnegative().default(0),
  })
  .strict();
export type InvokeToolRequest = z.infer<typeof InvokeToolRequest>;

/** Error kinds surfaced in an IpcError. Maps 1-1 with HTTP status families. */
export const IpcErrorKind = z.enum([
  "validation",
  "not-found",
  "permission",
  "timeout",
  "internal",
  "unavailable",
]);
export type IpcErrorKind = z.infer<typeof IpcErrorKind>;

/** Error body returned in any non-2xx IPC response. */
export const IpcError = z.object({
  kind: IpcErrorKind,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type IpcError = z.infer<typeof IpcError>;

/**
 * Response envelope — either `{ result }` or `{ error }`. Never both.
 *
 * `.strict()` plus `.refine()` forces the union to actually discriminate:
 * without the refinement, `z.unknown()` is satisfied by `undefined`, so `{}`
 * or `{ error: ... }` would silently match the `result` branch. The refine
 * check on the result branch requires the key to be physically present.
 */
export const InvokeToolResponse = z.union([
  z
    .object({ result: z.unknown() })
    .strict()
    .refine((v) => "result" in v, {
      message: "result envelope must contain a `result` key",
    }),
  z.object({ error: IpcError }).strict(),
]);
export type InvokeToolResponse = z.infer<typeof InvokeToolResponse>;

// ---------------------------------------------------------------------------
// SpawnRequest / SpawnResultPost — long-poll spawn callback (D-09)
// ---------------------------------------------------------------------------

/**
 * Spawn request envelope placed on the daemon's queue for a long-polling plugin
 * to claim. Wave 2 wires this end-to-end; the schema is declared here so the
 * envelope contract is stable from the start.
 */
export const SpawnRequest = z.object({
  id: z.string(),
  taskId: z.string(),
  taskPath: z.string(),
  agent: z.string(),
  priority: z.string(),
  thinking: z.string().optional(),
  routing: z.object({
    role: z.string().optional(),
    team: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  projectId: z.string().optional(),
  projectRoot: z.string().optional(),
  taskRelpath: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  correlationId: z.string().optional(),
  callbackDepth: z.number().int().nonnegative().default(0),
});
export type SpawnRequest = z.infer<typeof SpawnRequest>;

/** Plugin-posted outcome of a spawn. */
export const SpawnResultPost = z.object({
  sessionId: z.string(),
  success: z.boolean(),
  aborted: z.boolean(),
  error: z
    .object({
      kind: z.string(),
      message: z.string(),
    })
    .optional(),
  durationMs: z.number().nonnegative(),
});
export type SpawnResultPost = z.infer<typeof SpawnResultPost>;

// ---------------------------------------------------------------------------
// Session-event forwarders (D-07 + A1 amendment)
// ---------------------------------------------------------------------------

/**
 * Base shape for the four state-mutating session hooks. The plugin calls
 * `withCtx(event, ctx)` before forwarding, which spreads context identifiers
 * (sessionId / sessionKey / agentId) alongside per-event extras. We use
 * `.passthrough()` because per-gateway extras are gateway-specific and not
 * worth modelling in the core.
 */
const EventBase = z
  .object({
    sessionId: z.string().optional(),
    sessionKey: z.string().optional(),
    agentId: z.string().optional(),
  })
  .passthrough();

export const SessionEndEvent = EventBase;
export const AgentEndEvent = EventBase;
export const BeforeCompactionEvent = EventBase;
export const MessageReceivedEvent = EventBase;
export type SessionEndEvent = z.infer<typeof SessionEndEvent>;
export type AgentEndEvent = z.infer<typeof AgentEndEvent>;
export type BeforeCompactionEvent = z.infer<typeof BeforeCompactionEvent>;
export type MessageReceivedEvent = z.infer<typeof MessageReceivedEvent>;
