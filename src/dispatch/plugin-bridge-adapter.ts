/**
 * PluginBridgeAdapter — GatewayAdapter that delegates spawn execution to a
 * long-polling plugin (D-10).
 *
 * `spawnSession()` enqueues a {@link SpawnRequest} onto the shared
 * `SpawnQueue` and records the `onRunComplete` callback keyed by the
 * server-generated `spawnId`. The plugin consumes the request via
 * `GET /v1/spawns/wait` and posts the outcome via `POST /v1/spawns/{id}/result`,
 * which calls `deliverResult()` here — firing the recorded callback with an
 * `AgentRunOutcome`.
 *
 * D-12 sentinel: when no plugin is attached the adapter returns
 * `{ success: false, error: "no-plugin-attached" }`. The `SelectingAdapter`
 * is the primary check; this is defense-in-depth so the adapter behaves the
 * same whether invoked directly or through the selector.
 *
 * T-43-04 mitigation: the pending map is keyed by spawnId and the entry is
 * DELETED on delivery. A replayed result post finds no entry and is ignored
 * (idempotent). ids are server-generated via `randomUUID()` (in SpawnQueue)
 * so they aren't forgeable from outside same-uid trust.
 *
 * @module dispatch/plugin-bridge-adapter
 */

import { createLogger } from "../logging/index.js";
import type {
  GatewayAdapter,
  TaskContext,
  SpawnResult,
  SessionStatus,
  AgentRunOutcome,
} from "./executor.js";
import type { SpawnQueue } from "../ipc/spawn-queue.js";
import type { PluginRegistry } from "../ipc/plugin-registry.js";
import type { SpawnResultPost } from "../ipc/schemas.js";

const log = createLogger("plugin-bridge-adapter");

interface PendingEntry {
  taskId: string;
  onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
}

export class PluginBridgeAdapter implements GatewayAdapter {
  private pending = new Map<string, PendingEntry>();

  constructor(
    private readonly queue: SpawnQueue,
    private readonly registry: PluginRegistry,
  ) {}

  async spawnSession(
    context: TaskContext,
    opts?: {
      timeoutMs?: number;
      correlationId?: string;
      onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
    },
  ): Promise<SpawnResult> {
    if (!this.registry.hasActivePlugin()) {
      // D-12 sentinel — SelectingAdapter also checks; defense-in-depth.
      return { success: false, error: "no-plugin-attached" };
    }

    // callbackDepth flows via the envelope (D-06) rather than AOF_CALLBACK_DEPTH
    // env mutation. context.metadata may be undefined for fresh dispatches.
    const callbackDepth =
      typeof context.metadata?.callbackDepth === "number"
        ? (context.metadata.callbackDepth as number)
        : 0;

    const sr = this.queue.enqueue({
      taskId: context.taskId,
      taskPath: context.taskPath,
      agent: context.agent,
      priority: context.priority,
      thinking: context.thinking as string | undefined,
      routing: context.routing,
      projectId: context.projectId,
      projectRoot: context.projectRoot,
      taskRelpath: context.taskRelpath,
      timeoutMs: opts?.timeoutMs ?? context.timeoutMs,
      correlationId: opts?.correlationId,
      callbackDepth,
    });

    this.pending.set(sr.id, { taskId: context.taskId, onRunComplete: opts?.onRunComplete });
    log.info(
      { spawnId: sr.id, taskId: context.taskId, agent: context.agent },
      "spawn enqueued for plugin",
    );

    // sessionId carries the server-generated spawnId until the plugin posts the
    // real gateway sessionId via deliverResult(). The dispatcher treats this as
    // opaque; it's only meaningful to the adapter pair.
    return { success: true, sessionId: sr.id };
  }

  /**
   * Called by `POST /v1/spawns/{id}/result` (via `deps.deliverSpawnResult`)
   * to fire the dispatch-pipeline callback. `taskId` is optional — when the
   * route handler knows it (tests pass it explicitly), we use that value;
   * otherwise we fall back to the taskId recorded during spawnSession.
   */
  async deliverResult(
    spawnId: string,
    result: SpawnResultPost,
    taskId?: string,
  ): Promise<void> {
    const rec = this.pending.get(spawnId);
    this.pending.delete(spawnId);
    if (!rec) {
      log.warn({ spawnId }, "deliverResult: no pending entry — ignoring (replay or timeout)");
      return;
    }
    if (!rec.onRunComplete) return;

    const outcome: AgentRunOutcome = {
      taskId: taskId ?? rec.taskId,
      sessionId: result.sessionId,
      success: result.success,
      aborted: result.aborted,
      error: result.error,
      durationMs: result.durationMs,
    };

    try {
      await rec.onRunComplete(outcome);
    } catch (err) {
      log.error({ err, spawnId, taskId: outcome.taskId }, "onRunComplete callback threw");
    }
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    // `alive` is true for as long as we're awaiting a result post. Once
    // deliverResult fires, the entry is removed and subsequent polls report
    // not-alive — the dispatcher has the outcome via the callback already.
    return { sessionId, alive: this.pending.has(sessionId) };
  }

  async forceCompleteSession(sessionId: string): Promise<void> {
    const rec = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    if (rec?.onRunComplete) {
      try {
        await rec.onRunComplete({
          taskId: rec.taskId,
          sessionId,
          success: false,
          aborted: true,
          durationMs: 0,
        });
      } catch (err) {
        log.error(
          { err, spawnId: sessionId, taskId: rec.taskId },
          "forceComplete onRunComplete threw",
        );
      }
    }
  }
}
