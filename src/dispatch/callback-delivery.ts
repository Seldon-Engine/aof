/**
 * Callback delivery — spawns notification sessions to subscriber agents
 * when tasks reach terminal states.
 *
 * Covers: DLVR-01 (session spawn), DLVR-02 (retry), DLVR-03 (trace),
 * DLVR-04 (non-blocking best-effort), GRAN-01 (completion filter).
 */

import { randomUUID } from "node:crypto";
import type { Task } from "../schemas/task.js";
import type { TaskSubscription } from "../schemas/subscription.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { SubscriptionStore } from "../store/subscription-store.js";
import type { GatewayAdapter, TaskContext } from "./executor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["done", "cancelled", "deadletter"]);
const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes per user decision
const MAX_DELIVERY_ATTEMPTS = 3;
const MIN_RETRY_INTERVAL_MS = 30_000; // skip retries within 30s

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeliverCallbacksOptions {
  taskId: string;
  store: ITaskStore;
  subscriptionStore: SubscriptionStore;
  executor: GatewayAdapter;
  logger: { log: (...args: unknown[]) => void; emit?: (event: string, data?: unknown) => void };
  tracePath?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deliver callbacks to all eligible subscribers for a terminal task.
 * Best-effort: errors are caught and never propagate to the caller (DLVR-04).
 */
export async function deliverCallbacks(opts: DeliverCallbacksOptions): Promise<void> {
  const { taskId, store, subscriptionStore, executor, logger } = opts;

  const task = await store.get(taskId);
  if (!task || !TERMINAL_STATUSES.has(task.frontmatter.status)) {
    return;
  }

  const activeSubs = await subscriptionStore.list(taskId, { status: "active" });
  const completionSubs = activeSubs.filter((s) => s.granularity === "completion");

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
  const { taskId, store, subscriptionStore, executor, logger } = opts;

  const task = await store.get(taskId);
  if (!task || !TERMINAL_STATUSES.has(task.frontmatter.status)) {
    return;
  }

  const activeSubs = await subscriptionStore.list(taskId, { status: "active" });
  const retryCandidates = activeSubs.filter(
    (s) =>
      s.granularity === "completion" &&
      s.deliveryAttempts > 0 &&
      s.deliveryAttempts < MAX_DELIVERY_ATTEMPTS,
  );

  const now = Date.now();
  for (const sub of retryCandidates) {
    // Skip if last attempt was too recent
    if (sub.lastAttemptAt) {
      const elapsed = now - new Date(sub.lastAttemptAt).getTime();
      if (elapsed < MIN_RETRY_INTERVAL_MS) {
        continue;
      }
    }

    try {
      await deliverSingleCallback(task, sub, opts);
    } catch (_err) {
      // Best-effort retry
    }
  }
}

/**
 * Build a structured callback prompt for the subscriber agent.
 * Includes task outcome summary and extracted Outputs section.
 */
export function buildCallbackPrompt(
  task: Task,
  sub: TaskSubscription,
  tracePath?: string,
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

  const outputs = extractOutputsSection(task.body);
  if (outputs) {
    lines.push("", "## Outputs", "", outputs);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Deliver a single callback to a subscriber agent via session spawn.
 */
async function deliverSingleCallback(
  task: Task,
  sub: TaskSubscription,
  opts: DeliverCallbacksOptions,
): Promise<void> {
  const { subscriptionStore, executor, logger, tracePath } = opts;
  const prompt = buildCallbackPrompt(task, sub, tracePath);

  const context: TaskContext = {
    taskId: task.frontmatter.id,
    taskPath: "",
    agent: sub.subscriberId,
    priority: "normal",
    routing: { role: sub.subscriberId },
    taskFileContents: prompt,
  };

  try {
    const result = await executor.spawnSession(context, {
      timeoutMs: CALLBACK_TIMEOUT_MS,
      correlationId: randomUUID(),
      onRunComplete: async (outcome) => {
        // DLVR-03: capture trace on completion
        logger.log?.(`Callback session completed for ${task.frontmatter.id}: success=${outcome.success}`);
      },
    });

    if (result.success) {
      await subscriptionStore.update(task.frontmatter.id, sub.id, {
        status: "delivered",
        deliveredAt: new Date().toISOString(),
      });
      logger.emit?.("subscription.delivered", { taskId: task.frontmatter.id, subscriptionId: sub.id });
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
    logger.emit?.("subscription.delivery_failed", {
      taskId: task.frontmatter.id,
      subscriptionId: sub.id,
      attempts: newAttempts,
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
