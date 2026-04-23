/**
 * Non-Zod types for the IPC module.
 *
 * `IpcDeps` is the dependency bag injected into every route handler by
 * `attachIpcRoutes`. The Wave 2 fields (`spawnQueue`, `pluginRegistry`,
 * `deliverSpawnResult`) are declared optional here so Wave 1 daemon wiring
 * compiles without them; Wave 2 will mark them required.
 *
 * @module ipc/types
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { AOFService } from "../service/aof-service.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { createLogger } from "../logging/index.js";
import type { SpawnResultPost, ChatDeliveryResultPost } from "./schemas.js";
import type { SpawnQueue } from "./spawn-queue.js";
import type { ChatDeliveryQueue } from "./chat-delivery-queue.js";
import type { PluginRegistry } from "./plugin-registry.js";

/** Resolves the daemon-side ITaskStore for a given (actor, projectId). */
export type ResolveStoreFn = (opts: {
  actor?: string;
  projectId?: string;
}) => Promise<ITaskStore>;

/** Dependency bag every IPC route handler receives. */
export interface IpcDeps {
  /** Shared tool registry — dispatched by /v1/tool/invoke. */
  toolRegistry: ToolRegistry;
  /** Returns a permission-aware, project-scoped store for the caller. */
  resolveStore: ResolveStoreFn;
  /** Event logger for persisted audit events. */
  logger: EventLogger;
  /** AOFService handle — session-event routes trigger poll via this. */
  service: AOFService;
  /** Structured logger for this IPC module's operational diagnostics. */
  log: ReturnType<typeof createLogger>;

  /** Wave 2 — spawn queue for long-poll dispatch. */
  spawnQueue?: SpawnQueue;
  /** Wave 2 — plugin registry tracking active long-poll handles. */
  pluginRegistry?: PluginRegistry;
  /**
   * Wave 2 — delivers a plugin-posted spawn result back into the dispatch pipeline.
   *
   * The daemon (43-05) wires this to `pluginBridgeAdapter.deliverResult(id, result)`.
   * The adapter owns the `spawnId → { taskId, onRunComplete }` map so the IPC route
   * can stay free of dispatch-pipeline bookkeeping.
   */
  deliverSpawnResult?: (
    id: string,
    result: SpawnResultPost,
  ) => Promise<void>;

  /** Queue backing the chat-delivery long-poll (plugin-owned completion notifications). */
  chatDeliveryQueue?: ChatDeliveryQueue;
  /**
   * Settles the awaiting `MatrixMessageTool.send()` promise on the daemon side.
   * The daemon wires this to `chatDeliveryQueue.deliverResult`.
   */
  deliverChatResult?: (id: string, result: ChatDeliveryResultPost) => void;
}

/** Signature of an IPC route handler. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  deps: IpcDeps,
) => Promise<void>;
