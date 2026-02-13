/**
 * Notification service with deduplication per P2.4 / P3.3 spec.
 *
 * Implements the notification policy from docs/notification-policy.md:
 * - 5-minute dedupe window per (taskId, eventType)
 * - Critical alerts never suppressed
 * - Channel routing based on event type
 */

import type { BaseEvent, EventType } from "../schemas/event.js";

export interface NotificationMessage {
  channel: string;
  text: string;
  event: BaseEvent;
}

export interface NotificationAdapter {
  send(channel: string, message: string): Promise<void>;
}

interface DedupeKey {
  taskId?: string;
  eventType: EventType;
}

const CRITICAL_EVENTS: readonly EventType[] = [
  "system.shutdown",
  "system.recovery",
] as const;

const EVENT_TO_CHANNEL: Partial<Record<EventType, string>> = {
  // Task state transitions
  "task.created": "#aof-dispatch",
  "task.transitioned": "#aof-dispatch",
  "lease.acquired": "#aof-dispatch",
  "lease.expired": "#aof-alerts",
  "lease.released": "#aof-dispatch",

  // System events
  "system.startup": "#aof-alerts",
  "system.shutdown": "#aof-critical",
  "system.config-changed": "#aof-alerts",
  "system.drift-detected": "#aof-alerts",
  "system.recovery": "#aof-critical",

  // Scheduler events
  "scheduler.poll": "#aof-dispatch",
};

const EVENT_TEMPLATES: Partial<Record<EventType, (event: BaseEvent) => string>> = {
  "task.created": (e) => `📬 Task ${e.taskId} created: ${e.payload?.title ?? "Untitled"}`,
  "task.transitioned": (e) => {
    const { from, to, reason } = e.payload ?? {};
    if (to === "done") return `✅ ${e.actor} completed ${e.taskId}`;
    if (to === "review") return `👀 ${e.taskId} ready for review (by ${e.actor})`;
    if (to === "blocked") return `🚧 ${e.taskId} blocked: ${reason ?? "unknown reason"}`;
    if (to === "in-progress") return `▶️ ${e.actor} started ${e.taskId}`;
    return `🔄 ${e.taskId}: ${from} → ${to}`;
  },
  "lease.acquired": (e) => `▶️ ${e.actor} started ${e.taskId}`,
  "lease.expired": (e) => `⏰ Lease expired on ${e.taskId} (agent: ${e.actor})`,
  "lease.released": (e) => `⏸️ ${e.actor} released ${e.taskId}`,
  "system.startup": () => `🟢 AOF system started`,
  "system.shutdown": () => `🔴 AOF system shutting down`,
  "system.drift-detected": (e) => `⚠️ Org chart drift: ${e.payload?.summary ?? "unknown"}`,
  "system.recovery": () => `🟢 Scheduler recovered`,
  "scheduler.poll": (e) => {
    const { actionsPlanned = 0 } = e.payload ?? {};
    if (actionsPlanned === 0) return "";
    return `🔄 Scheduler: ${actionsPlanned} actions planned`;
  },
};

export class NotificationService {
  private readonly adapter: NotificationAdapter;
  private readonly lastSent = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly enabled: boolean;

  constructor(adapter: NotificationAdapter, opts?: { ttlMs?: number; enabled?: boolean }) {
    this.adapter = adapter;
    this.ttlMs = opts?.ttlMs ?? 300_000; // 5 minutes
    this.enabled = opts?.enabled ?? true;
  }

  private isCritical(eventType: EventType): boolean {
    return (CRITICAL_EVENTS as readonly string[]).includes(eventType);
  }

  private shouldSend(key: DedupeKey): boolean {
    if (this.isCritical(key.eventType)) return true;

    const keyStr = `${key.taskId ?? "global"}:${key.eventType}`;
    const last = this.lastSent.get(keyStr) ?? 0;
    const now = Date.now();

    if (now - last < this.ttlMs) {
      return false; // Suppressed
    }

    this.lastSent.set(keyStr, now);
    return true;
  }

  private resolveChannel(eventType: EventType): string {
    return EVENT_TO_CHANNEL[eventType] ?? "#aof-dispatch";
  }

  private renderMessage(event: BaseEvent): string {
    const template = EVENT_TEMPLATES[event.type];
    if (!template) return `[${event.type}] ${event.taskId ?? "global"}`;
    return template(event);
  }

  async notify(event: BaseEvent): Promise<void> {
    if (!this.enabled) return;

    const key: DedupeKey = {
      taskId: event.taskId,
      eventType: event.type,
    };

    if (!this.shouldSend(key)) return;

    const channel = this.resolveChannel(event.type);
    const message = this.renderMessage(event);
    if (!message) return; // Empty message (e.g., no-op scheduler.poll)

    await this.adapter.send(channel, message);
  }
}

/**
 * Mock notification adapter for testing.
 */
export class MockNotificationAdapter implements NotificationAdapter {
  readonly sent: Array<{ channel: string; message: string }> = [];

  async send(channel: string, message: string): Promise<void> {
    this.sent.push({ channel, message });
  }

  clear(): void {
    this.sent.length = 0;
  }
}
