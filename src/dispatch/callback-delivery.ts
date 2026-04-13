/**
 * Callback delivery — spawns notification sessions to subscriber agents
 * when tasks reach terminal states.
 *
 * Covers: DLVR-01 (session spawn), DLVR-02 (retry), DLVR-03 (trace),
 * DLVR-04 (non-blocking best-effort), GRAN-01 (completion filter).
 */

import { randomUUID } from "node:crypto";
import type { Task } from "../schemas/task.js";
import { resolveDeliveryKind, type TaskSubscription } from "../schemas/subscription.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { SubscriptionStore } from "../store/subscription-store.js";
import type { GatewayAdapter, TaskContext } from "./executor.js";
import type { EventLogger } from "../events/logger.js";
import { captureTrace } from "../trace/trace-writer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["done", "cancelled", "deadletter"]);
const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes per user decision
const MAX_DELIVERY_ATTEMPTS = 3;
const MIN_RETRY_INTERVAL_MS = 30_000; // skip retries within 30s
export const MAX_CALLBACK_DEPTH = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeliverCallbacksOptions {
  taskId: string;
  store: ITaskStore;
  subscriptionStore: SubscriptionStore;
  executor: GatewayAdapter;
  logger: EventLogger;
  tracePath?: string;
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deliver callbacks to all eligible subscribers for a terminal task.
 * Best-effort: errors are caught and never propagate to the caller (DLVR-04).
 */
export async function deliverCallbacks(opts: DeliverCallbacksOptions): Promise<void> {
  const { taskId, store, subscriptionStore, logger } = opts;

  const task = await store.get(taskId);
  if (!task || !TERMINAL_STATUSES.has(task.frontmatter.status)) {
    return;
  }

  // SAFE-01: Depth limiting — prevent infinite callback chains
  const depth = task.frontmatter.callbackDepth ?? 0;
  if (depth >= MAX_CALLBACK_DEPTH) {
    await logger.log("subscription.depth_exceeded", "callback-delivery", {
      taskId,
      payload: { depth, maxDepth: MAX_CALLBACK_DEPTH },
    });
    return;
  }

  const activeSubs = await subscriptionStore.list(taskId, { status: "active" });
  const completionSubs = activeSubs.filter(
    (s) => s.granularity === "completion" && resolveDeliveryKind(s) === "agent-callback",
  );

  for (const sub of completionSubs) {
    try {
      await deliverSingleCallback(task, sub, opts);
    } catch (_err) {
      // DLVR-04: best-effort, never propagate
    }
  }
}

/**
 * Retry pending deliveries — finds active subscriptions with prior failed
 * attempts (0 < deliveryAttempts < MAX) on terminal tasks and retries them.
 * Skips subscriptions attempted within MIN_RETRY_INTERVAL_MS (DLVR-02).
 */
export async function retryPendingDeliveries(opts: DeliverCallbacksOptions): Promise<void> {
  const { taskId, store, subscriptionStore, logger } = opts;

  const task = await store.get(taskId);
  if (!task || !TERMINAL_STATUSES.has(task.frontmatter.status)) {
    return;
  }

  const activeSubs = await subscriptionStore.list(taskId, { status: "active" });
  // SAFE-02: Expanded filter — include both granularities and deliveryAttempts >= 0
  // (handles never-attempted recovery AND retry of previously failed attempts)
  const retryCandidates = activeSubs.filter(
    (s) => s.deliveryAttempts < MAX_DELIVERY_ATTEMPTS && resolveDeliveryKind(s) === "agent-callback",
  );

  const now = Date.now();
  for (const sub of retryCandidates) {
    // Skip if last attempt was too recent (only applies to previously attempted)
    if (sub.lastAttemptAt) {
      const elapsed = now - new Date(sub.lastAttemptAt).getTime();
      if (elapsed < MIN_RETRY_INTERVAL_MS) {
        continue;
      }
    }

    try {
      // SAFE-02: Emit recovery event for never-attempted subscriptions
      if (sub.deliveryAttempts === 0) {
        await logger.log("subscription.recovery_attempted", "callback-delivery", {
          taskId,
          payload: { subscriptionId: sub.id, granularity: sub.granularity },
        });
      }

      // Route based on granularity
      if (sub.granularity === "all") {
        // For "all" granularity, use transition-based delivery
        await deliverAllGranularityForSub(task, sub, opts);
      } else {
        await deliverSingleCallback(task, sub, opts);
      }
    } catch (_err) {
      // Best-effort retry
    }
  }
}

/**
 * Transition record for all-granularity batched delivery.
 */
export interface TransitionRecord {
  fromStatus: string;
  toStatus: string;
  timestamp: string;
}

/**
 * Build a structured callback prompt for the subscriber agent.
 * Includes task outcome summary and extracted Outputs section.
 * When transitions are provided (all-granularity), includes a Transitions section.
 */
export function buildCallbackPrompt(
  task: Task,
  sub: TaskSubscription,
  tracePath?: string,
  transitions?: TransitionRecord[],
): string {
  const lines: string[] = [
    "You are receiving a task notification callback.",
    "",
    `Task ID: ${task.frontmatter.id}`,
    `Title: ${task.frontmatter.title}`,
    `Final Status: ${task.frontmatter.status}`,
    `Subscriber: ${sub.subscriberId}`,
  ];

  if (tracePath) {
    lines.push(`Trace: ${tracePath}`);
  }

  if (transitions && transitions.length > 0) {
    lines.push("", "## Transitions", "");
    for (const t of transitions) {
      lines.push(`- ${t.fromStatus} -> ${t.toStatus} at ${t.timestamp}`);
    }
  }

  const outputs = extractOutputsSection(task.body);
  if (outputs) {
    lines.push("", "## Outputs", "", outputs);
  }

  return lines.join("\n");
}

/**
 * Deliver batched transition callbacks to all active "all" granularity subscribers.
 * For each subscriber, scans the event log for task.transitioned events after
 * the subscriber's lastDeliveredAt cursor, batches them into a single callback,
 * and advances the cursor on success.
 *
 * Does NOT require terminal status — fires on every state transition.
 * Best-effort: errors per subscriber are caught and never propagate (DLVR-04).
 */
export async function deliverAllGranularityCallbacks(opts: DeliverCallbacksOptions): Promise<void> {
  const { taskId, store, subscriptionStore, logger } = opts;

  const task = await store.get(taskId);
  if (!task) return;

  // SAFE-01: Depth limiting — prevent infinite callback chains
  const depth = task.frontmatter.callbackDepth ?? 0;
  if (depth >= MAX_CALLBACK_DEPTH) {
    await logger.log("subscription.depth_exceeded", "callback-delivery", {
      taskId,
      payload: { depth, maxDepth: MAX_CALLBACK_DEPTH },
    });
    return;
  }

  const activeSubs = await subscriptionStore.list(taskId, { status: "active" });
  const allSubs = activeSubs.filter(
    (s) => s.granularity === "all" && resolveDeliveryKind(s) === "agent-callback",
  );

  for (const sub of allSubs) {
    try {
      const lastDeliveredAtMs = sub.lastDeliveredAt
        ? new Date(sub.lastDeliveredAt).getTime()
        : 0;

      // Query all task.transitioned events for this task
      const events = await logger.query({ type: "task.transitioned", taskId });

      // Filter to events after lastDeliveredAt and sort chronologically
      const newEvents = events
        .filter((e) => new Date(e.timestamp).getTime() > lastDeliveredAtMs)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      if (newEvents.length === 0) continue;

      // Map to transition records
      const transitions: TransitionRecord[] = newEvents.map((e) => ({
        fromStatus: String((e.payload as Record<string, unknown>).from ?? ""),
        toStatus: String((e.payload as Record<string, unknown>).to ?? ""),
        timestamp: e.timestamp,
      }));

      // Build prompt with transitions
      const prompt = buildCallbackPrompt(task, sub, opts.tracePath, transitions);

      const context: TaskContext = {
        taskId: task.frontmatter.id,
        taskPath: "",
        agent: sub.subscriberId,
        priority: "normal",
        routing: { role: sub.subscriberId },
        taskFileContents: prompt,
        metadata: { callbackDepth: (task.frontmatter.callbackDepth ?? 0) + 1 },
      };

      const result = await opts.executor.spawnSession(context, {
        timeoutMs: CALLBACK_TIMEOUT_MS,
        correlationId: randomUUID(),
      });

      if (result.success) {
        // Advance cursor to latest transition timestamp
        const latestTimestamp = transitions[transitions.length - 1]!.timestamp;
        await subscriptionStore.update(taskId, sub.id, {
          lastDeliveredAt: latestTimestamp,
        });
      }
      // On failure, do NOT advance lastDeliveredAt (self-healing cursor)
    } catch (_err) {
      // DLVR-04: best-effort, never propagate
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Deliver an "all" granularity callback for a single subscriber during recovery.
 * Scans event log for transitions after lastDeliveredAt, batches into a single callback.
 */
async function deliverAllGranularityForSub(
  task: Task,
  sub: TaskSubscription,
  opts: DeliverCallbacksOptions,
): Promise<void> {
  const { subscriptionStore, logger } = opts;

  const lastDeliveredAtMs = sub.lastDeliveredAt
    ? new Date(sub.lastDeliveredAt).getTime()
    : 0;

  const events = await logger.query({ type: "task.transitioned", taskId: task.frontmatter.id });

  const newEvents = events
    .filter((e) => new Date(e.timestamp).getTime() > lastDeliveredAtMs)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (newEvents.length === 0) return;

  const transitions: TransitionRecord[] = newEvents.map((e) => ({
    fromStatus: String((e.payload as Record<string, unknown>).from ?? ""),
    toStatus: String((e.payload as Record<string, unknown>).to ?? ""),
    timestamp: e.timestamp,
  }));

  const prompt = buildCallbackPrompt(task, sub, opts.tracePath, transitions);

  const context: TaskContext = {
    taskId: task.frontmatter.id,
    taskPath: "",
    agent: sub.subscriberId,
    priority: "normal",
    routing: { role: sub.subscriberId },
    taskFileContents: prompt,
    metadata: { callbackDepth: (task.frontmatter.callbackDepth ?? 0) + 1 },
  };

  const result = await opts.executor.spawnSession(context, {
    timeoutMs: CALLBACK_TIMEOUT_MS,
    correlationId: randomUUID(),
  });

  if (result.success) {
    const latestTimestamp = transitions[transitions.length - 1]!.timestamp;
    await subscriptionStore.update(task.frontmatter.id, sub.id, {
      status: "delivered",
      deliveredAt: new Date().toISOString(),
      lastDeliveredAt: latestTimestamp,
    });
  } else {
    await handleDeliveryFailure(task, sub, opts, result.error || "spawn failed");
  }
}

/**
 * Deliver a single callback to a subscriber agent via session spawn.
 */
async function deliverSingleCallback(
  task: Task,
  sub: TaskSubscription,
  opts: DeliverCallbacksOptions,
): Promise<void> {
  const { subscriptionStore, executor, logger, tracePath, debug = false } = opts;
  const prompt = buildCallbackPrompt(task, sub, tracePath);

  const context: TaskContext = {
    taskId: task.frontmatter.id,
    taskPath: "",
    agent: sub.subscriberId,
    priority: "normal",
    routing: { role: sub.subscriberId },
    taskFileContents: prompt,
    metadata: { callbackDepth: (task.frontmatter.callbackDepth ?? 0) + 1 },
  };

  try {
    // SAFE-01: Set env var so spawned agent's MCP context inherits callbackDepth
    process.env.AOF_CALLBACK_DEPTH = String(context.metadata?.callbackDepth ?? 0);
    const result = await executor.spawnSession(context, {
      timeoutMs: CALLBACK_TIMEOUT_MS,
      correlationId: randomUUID(),
      onRunComplete: async (outcome) => {
        // DLVR-03: capture trace on completion (best-effort)
        try {
          await captureTrace({
            taskId: task.frontmatter.id,
            sessionId: outcome.sessionId,
            agentId: sub.subscriberId,
            durationMs: outcome.durationMs,
            store: opts.store,
            logger,
            debug,
          });
        } catch (_traceErr) {
          // Best-effort: trace capture failure must not block delivery
        }

        await logger.log("subscription.delivery_attempted", "callback-delivery", {
          taskId: task.frontmatter.id,
          payload: { subscriptionId: sub.id, success: outcome.success },
        });
      },
    });

    if (result.success) {
      await subscriptionStore.update(task.frontmatter.id, sub.id, {
        status: "delivered",
        deliveredAt: new Date().toISOString(),
      });
      await logger.log("subscription.delivered", "callback-delivery", {
        taskId: task.frontmatter.id,
        payload: { subscriptionId: sub.id },
      });
    } else {
      await handleDeliveryFailure(task, sub, opts, result.error || "spawn failed");
    }
  } catch (err) {
    await handleDeliveryFailure(
      task,
      sub,
      opts,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    // SAFE-01: Clean up env var after spawn to avoid stale values
    delete process.env.AOF_CALLBACK_DEPTH;
  }
}

/**
 * Handle a failed delivery attempt — increment counter, potentially mark as failed.
 */
async function handleDeliveryFailure(
  task: Task,
  sub: TaskSubscription,
  opts: DeliverCallbacksOptions,
  errorMessage: string,
): Promise<void> {
  const { subscriptionStore, logger } = opts;
  const newAttempts = (sub.deliveryAttempts ?? 0) + 1;
  const now = new Date().toISOString();

  if (newAttempts >= MAX_DELIVERY_ATTEMPTS) {
    await subscriptionStore.update(task.frontmatter.id, sub.id, {
      status: "failed",
      failureReason: `Delivery failed after ${newAttempts} attempts: ${errorMessage}`,
      deliveryAttempts: newAttempts,
      lastAttemptAt: now,
    });
    await logger.log("subscription.delivery_failed", "callback-delivery", {
      taskId: task.frontmatter.id,
      payload: { subscriptionId: sub.id, attempts: newAttempts },
    });
  } else {
    await subscriptionStore.update(task.frontmatter.id, sub.id, {
      deliveryAttempts: newAttempts,
      lastAttemptAt: now,
    });
  }
}

/**
 * Extract the "## Outputs" section from a task body.
 * Returns the text between "## Outputs" and the next "## " marker (or end of string).
 */
function extractOutputsSection(body?: string): string | undefined {
  if (!body) return undefined;

  const marker = "## Outputs";
  const startIdx = body.indexOf(marker);
  if (startIdx === -1) return undefined;

  const contentStart = startIdx + marker.length;
  const nextSection = body.indexOf("\n## ", contentStart);
  const section = nextSection === -1
    ? body.slice(contentStart)
    : body.slice(contentStart, nextSection);

  return section.trim() || undefined;
}
