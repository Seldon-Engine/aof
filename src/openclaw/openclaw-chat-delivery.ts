/**
 * OpenClaw chat-message delivery — plugin-owned subscription delivery kind.
 *
 * Registers as an EventLogger callback and fires on actionable task
 * transitions ({blocked, review, done, cancelled, deadletter}). For each
 * matching active subscription with `delivery.kind === "openclaw-chat"`,
 * sends a message to the captured session/channel via the OpenClaw
 * message tool. Per-status dedupe is persisted on the subscription.
 *
 * This module owns OpenClaw idioms (sessionKey, sessionId, replyTarget,
 * channel, threadId) so AOF core stays session-agnostic.
 */

import { join } from "node:path";
import { createLogger } from "../logging/index.js";
import { readRunResult } from "../recovery/run-artifacts.js";
import { resolveDeliveryKind, type TaskSubscription } from "../schemas/subscription.js";
import { SubscriptionStore } from "../store/subscription-store.js";
import type { BaseEvent } from "../schemas/event.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { MatrixMessageTool } from "./matrix-notifier.js";
import { OPENCLAW_CHAT_DELIVERY_KIND } from "./subscription-delivery.js";
import type { OpenClawChatDeliveryType } from "./subscription-delivery.js";

const log = createLogger("openclaw-chat-delivery");

export { OPENCLAW_CHAT_DELIVERY_KIND } from "./subscription-delivery.js";

const TRIGGER_STATUSES = new Set(["blocked", "review", "done", "cancelled", "deadletter"]);
const TERMINAL_STATUSES = new Set(["done", "cancelled", "deadletter"]);
const NOTES_TRUNCATION_LIMIT = 240;
const ELLIPSIS = "...";

export interface OpenClawChatDeliveryOptions {
  resolveStoreForTask: (taskId: string) => Promise<ITaskStore | undefined>;
  messageTool: MatrixMessageTool;
}

export class OpenClawChatDeliveryNotifier {
  constructor(private readonly opts: OpenClawChatDeliveryOptions) {}

  async handleEvent(event: BaseEvent): Promise<void> {
    if (event.type !== "task.transitioned" || !event.taskId) return;
    const to = typeof event.payload.to === "string" ? event.payload.to : undefined;
    if (!to || !TRIGGER_STATUSES.has(to)) return;

    const store = await this.opts.resolveStoreForTask(event.taskId);
    if (!store) return;

    const task = await store.get(event.taskId);
    if (!task) return;

    const subscriptionStore = this.createSubscriptionStore(store);
    const active = await subscriptionStore.list(event.taskId, { status: "active" });
    const chatSubs = active.filter(
      (s) => resolveDeliveryKind(s) === OPENCLAW_CHAT_DELIVERY_KIND
        && !s.notifiedStatuses.includes(to),
    );
    if (chatSubs.length === 0) return;

    const runResult = await readRunResult(store, event.taskId).catch(() => undefined);

    for (const sub of chatSubs) {
      await this.deliverOne({
        sub,
        subscriptionStore,
        task,
        toStatus: to,
        actor: event.actor,
        reason: typeof event.payload.reason === "string" ? event.payload.reason : undefined,
        runResult,
      }).catch((err) => {
        log.error({ err, taskId: event.taskId, subscriptionId: sub.id }, "chat delivery failed");
      });
    }
  }

  private async deliverOne(args: {
    sub: TaskSubscription;
    subscriptionStore: SubscriptionStore;
    task: Awaited<ReturnType<ITaskStore["get"]>>;
    toStatus: string;
    actor: string;
    reason?: string;
    runResult: Awaited<ReturnType<typeof readRunResult>> | undefined;
  }): Promise<void> {
    const { sub, subscriptionStore, task, toStatus, actor, reason, runResult } = args;
    if (!task) return;

    const delivery = sub.delivery as OpenClawChatDeliveryType | undefined;
    if (!delivery) return;
    const target = delivery.target ?? delivery.sessionKey ?? delivery.sessionId;
    if (!target) return;

    const message = renderMessage({ task, toStatus, actor, reason, runResult });

    const attemptedAt = new Date().toISOString();
    try {
      await this.opts.messageTool.send(target, message, {
        subscriptionId: sub.id,
        taskId: task.frontmatter.id,
        toStatus,
        delivery: sub.delivery as Record<string, unknown> | undefined,
      });
      await subscriptionStore.appendAttempt(task.frontmatter.id, sub.id, {
        attemptedAt,
        success: true,
        toStatus,
      });
      await subscriptionStore.markStatusNotified(task.frontmatter.id, sub.id, toStatus);
      if (TERMINAL_STATUSES.has(toStatus)) {
        await subscriptionStore.update(task.frontmatter.id, sub.id, {
          status: "delivered",
          deliveredAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : String(err);
      const kind =
        err && typeof err === "object" && "kind" in err && typeof (err as { kind: unknown }).kind === "string"
          ? ((err as { kind: string }).kind)
          : undefined;
      await subscriptionStore.appendAttempt(task.frontmatter.id, sub.id, {
        attemptedAt,
        success: false,
        toStatus,
        error: {
          ...(kind !== undefined ? { kind } : {}),
          message: failureMessage,
        },
      });
      log.error({ err, target, taskId: task.frontmatter.id }, "messageTool.send failed");
    }
  }

  private createSubscriptionStore(store: ITaskStore): SubscriptionStore {
    const tasksDir = store.tasksDir;
    return new SubscriptionStore(async (taskId) => {
      const t = await store.get(taskId);
      if (!t) throw new Error(`Task not found: ${taskId}`);
      return join(tasksDir, t.frontmatter.status, taskId);
    });
  }
}

function renderMessage(args: {
  task: NonNullable<Awaited<ReturnType<ITaskStore["get"]>>>;
  toStatus: string;
  actor: string;
  reason?: string;
  runResult: Awaited<ReturnType<typeof readRunResult>> | undefined;
}): string {
  const { task, toStatus, actor, reason, runResult } = args;
  const lines: string[] = [
    `${renderStatusLead(toStatus)}: ${task.frontmatter.id} ${task.frontmatter.title}`,
    `Agent: ${actor}`,
  ];

  if (runResult?.outcome) lines.push(`Outcome: ${runResult.outcome}`);
  if (runResult?.summaryRef) lines.push(`Summary: ${runResult.summaryRef}`);

  if (runResult?.blockers?.length) {
    lines.push(`Blockers: ${runResult.blockers.join("; ")}`);
  } else if (reason && reason.trim().length > 0) {
    lines.push(`Reason: ${reason.trim()}`);
  }

  if (runResult?.notes) {
    lines.push(`Notes: ${truncate(runResult.notes, NOTES_TRUNCATION_LIMIT)}`);
  }

  return lines.join("\n");
}

function renderStatusLead(status: string): string {
  switch (status) {
    case "done":
      return "Task complete";
    case "cancelled":
      return "Task cancelled";
    case "deadletter":
      return "Task dead-lettered";
    case "review":
      return "Task ready for review";
    case "blocked":
      return "Task blocked";
    default:
      return "Task update";
  }
}

function truncate(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  if (limit <= ELLIPSIS.length) return ELLIPSIS.slice(0, limit);
  return `${value.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`;
}
