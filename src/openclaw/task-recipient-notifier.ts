import type { BaseEvent } from "../schemas/event.js";
import type { ITaskStore } from "../store/interfaces.js";
import { readRunResult } from "../recovery/run-artifacts.js";
import type { MatrixMessageTool } from "./matrix-notifier.js";
import { getNotificationRecipient } from "./notification-recipient.js";
import type { EventLogger } from "../events/logger.js";

const NOTIFIABLE_STATUSES = new Set(["blocked", "review", "done"]);
const ELLIPSIS = "...";
const DEFAULT_DELIVERY_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_DELIVERIES = 2048;

interface OpenClawTaskRecipientNotifierOptions {
  deliveryTtlMs?: number;
  maxDeliveries?: number;
  now?: () => number;
  logger?: EventLogger;
}

export class OpenClawTaskRecipientNotifier {
  private readonly delivered = new Map<string, number>();
  private readonly deliveryTtlMs: number;
  private readonly maxDeliveries: number;
  private readonly now: () => number;
  private readonly logger?: EventLogger;

  constructor(
    private readonly resolveStoreForTask: (taskId: string) => Promise<ITaskStore | undefined>,
    private readonly messageTool: MatrixMessageTool,
    options: OpenClawTaskRecipientNotifierOptions = {},
  ) {
    this.deliveryTtlMs = options.deliveryTtlMs ?? DEFAULT_DELIVERY_TTL_MS;
    this.maxDeliveries = options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
  }

  async handleEvent(event: BaseEvent): Promise<void> {
    if (event.type !== "task.transitioned" || !event.taskId) {
      return;
    }

    const to = typeof event.payload.to === "string" ? event.payload.to : undefined;
    if (!to || !NOTIFIABLE_STATUSES.has(to)) {
      return;
    }

    const store = await this.resolveStoreForTask(event.taskId);
    if (!store) {
      return;
    }

    const task = await store.get(event.taskId);
    if (!task) {
      return;
    }

    const recipient = getNotificationRecipient(task);
    if (!recipient) {
      return;
    }

    const target = recipient.replyTarget ?? recipient.sessionKey ?? recipient.sessionId;
    if (!target) {
      return;
    }

    const deliveryKey = `${event.taskId}:${to}:${target}`;
    if (this.hasDelivered(deliveryKey)) {
      return;
    }

    const runResult = await readRunResult(store, event.taskId);
    const lines = [
      `${renderStatusLead(to)}: ${task.frontmatter.id} ${task.frontmatter.title}`,
      `Agent: ${event.actor}`,
    ];

    if (runResult?.outcome) {
      lines.push(`Outcome: ${runResult.outcome}`);
    }
    if (runResult?.summaryRef) {
      lines.push(`Summary: ${runResult.summaryRef}`);
    }
    if (runResult?.blockers?.length) {
      lines.push(`Blockers: ${runResult.blockers.join("; ")}`);
    } else if (typeof event.payload.reason === "string" && event.payload.reason.trim().length > 0) {
      lines.push(`Reason: ${event.payload.reason.trim()}`);
    }
    if (runResult?.notes) {
      lines.push(`Notes: ${truncate(runResult.notes, 240)}`);
    }

    try {
      await this.messageTool.send(target, lines.join("\n"));
      this.markDelivered(deliveryKey);
    } catch (err) {
      if (this.logger) {
        await this.logger.logDispatch("dispatch.error", "openclaw", event.taskId, {
          error: err instanceof Error ? err.message : String(err),
          source: "openclaw.task-recipient-notifier",
          target,
          status: to,
        });
      } else {
        console.error(`[AOF] Failed to deliver task notification for ${event.taskId}:`, err);
      }
    }
  }

  private hasDelivered(deliveryKey: string): boolean {
    this.pruneDelivered();
    const expiresAt = this.delivered.get(deliveryKey);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= this.now()) {
      this.delivered.delete(deliveryKey);
      return false;
    }
    return true;
  }

  private markDelivered(deliveryKey: string): void {
    this.pruneDelivered();
    this.delivered.set(deliveryKey, this.now() + this.deliveryTtlMs);
    while (this.delivered.size > this.maxDeliveries) {
      const oldestKey = this.delivered.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.delivered.delete(oldestKey);
    }
  }

  private pruneDelivered(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.delivered.entries()) {
      if (expiresAt <= now) {
        this.delivered.delete(key);
      }
    }
  }
}

function renderStatusLead(status: string): string {
  switch (status) {
    case "done":
      return "Task complete";
    case "review":
      return "Task ready for review";
    case "blocked":
      return "Task blocked";
    default:
      return "Task update";
  }
}

function truncate(value: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  if (value.length <= limit) {
    return value;
  }
  if (limit <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, limit);
  }
  return `${value.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`;
}
