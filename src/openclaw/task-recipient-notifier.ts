import type { BaseEvent } from "../schemas/event.js";
import type { ITaskStore } from "../store/interfaces.js";
import { readRunResult } from "../recovery/run-artifacts.js";
import type { MatrixMessageTool } from "./matrix-notifier.js";
import { getNotificationRecipient } from "./notification-recipient.js";

const NOTIFIABLE_STATUSES = new Set(["blocked", "review", "done"]);

export class OpenClawTaskRecipientNotifier {
  private readonly delivered = new Set<string>();

  constructor(
    private readonly resolveStoreForTask: (taskId: string) => Promise<ITaskStore | undefined>,
    private readonly messageTool: MatrixMessageTool,
  ) {}

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
    if (this.delivered.has(deliveryKey)) {
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
      this.delivered.add(deliveryKey);
    } catch (err) {
      console.error(`[AOF] Failed to deliver task notification for ${event.taskId}:`, err);
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
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}...`;
}
