import { describe, it, expect, beforeEach } from "vitest";
import { NotificationService, MockNotificationAdapter } from "../notifier.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("NotificationService", () => {
  let adapter: MockNotificationAdapter;
  let service: NotificationService;

  beforeEach(() => {
    adapter = new MockNotificationAdapter();
    service = new NotificationService(adapter, { ttlMs: 100 });
  });

  it("sends notification for task transition", async () => {
    const event: BaseEvent = {
      eventId: 1,
      type: "task.transitioned",
      timestamp: new Date().toISOString(),
      actor: "swe-backend",
      taskId: "TASK-2026-02-07-001",
      payload: { from: "ready", to: "done" },
    };

    await service.notify(event);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.channel).toBe("#aof-dispatch");
    expect(adapter.sent[0]!.message).toContain("completed");
    expect(adapter.sent[0]!.message).toContain("TASK-2026-02-07-001");
  });

  it("deduplicates within ttl window", async () => {
    const event: BaseEvent = {
      eventId: 1,
      type: "task.transitioned",
      timestamp: new Date().toISOString(),
      actor: "swe-backend",
      taskId: "TASK-2026-02-07-001",
      payload: { from: "ready", to: "in-progress" },
    };

    await service.notify(event);
    await service.notify(event); // Duplicate within 100ms

    expect(adapter.sent).toHaveLength(1);
  });

  it("sends after ttl expires", async () => {
    const event: BaseEvent = {
      eventId: 1,
      type: "task.transitioned",
      timestamp: new Date().toISOString(),
      actor: "swe-backend",
      taskId: "TASK-2026-02-07-001",
      payload: { from: "ready", to: "in-progress" },
    };

    await service.notify(event);
    await new Promise((resolve) => setTimeout(resolve, 150)); // Wait for TTL to expire
    await service.notify(event);

    expect(adapter.sent).toHaveLength(2);
  });

  it("never suppresses critical events", async () => {
    const event: BaseEvent = {
      eventId: 1,
      type: "system.shutdown",
      timestamp: new Date().toISOString(),
      actor: "system",
      payload: {},
    };

    await service.notify(event);
    await service.notify(event);
    await service.notify(event);

    expect(adapter.sent).toHaveLength(3);
    expect(adapter.sent[0]!.channel).toBe("#aof-critical");
  });

  it("routes to correct channels", async () => {
    const events: BaseEvent[] = [
      {
        eventId: 1,
        type: "task.transitioned",
        timestamp: new Date().toISOString(),
        actor: "agent",
        taskId: "T1",
        payload: { from: "ready", to: "done" },
      },
      {
        eventId: 2,
        type: "lease.expired",
        timestamp: new Date().toISOString(),
        actor: "scheduler",
        taskId: "T2",
        payload: {},
      },
      {
        eventId: 3,
        type: "system.drift-detected",
        timestamp: new Date().toISOString(),
        actor: "system",
        payload: {},
      },
    ];

    for (const event of events) {
      await service.notify(event);
    }

    expect(adapter.sent).toHaveLength(3);
    expect(adapter.sent[0]!.channel).toBe("#aof-dispatch");
    expect(adapter.sent[1]!.channel).toBe("#aof-alerts");
    expect(adapter.sent[2]!.channel).toBe("#aof-alerts");
  });

  it("respects enabled flag", async () => {
    const disabledService = new NotificationService(adapter, { enabled: false });

    const event: BaseEvent = {
      eventId: 1,
      type: "task.transitioned",
      timestamp: new Date().toISOString(),
      actor: "agent",
      taskId: "T1",
      payload: { from: "ready", to: "done" },
    };

    await disabledService.notify(event);

    expect(adapter.sent).toHaveLength(0);
  });

  it("renders task transition messages correctly", async () => {
    const transitions = [
      { to: "done", expected: "completed" },
      { to: "review", expected: "ready for review" },
      { to: "blocked", expected: "blocked" },
      { to: "in-progress", expected: "started" },
    ];

    let taskIdCounter = 1;
    for (const { to, expected } of transitions) {
      adapter.clear();

      const event: BaseEvent = {
        eventId: taskIdCounter,
        type: "task.transitioned",
        timestamp: new Date().toISOString(),
        actor: "agent",
        taskId: `T${taskIdCounter}`,
        payload: { from: "ready", to },
      };

      await service.notify(event);

      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0]!.message).toContain(expected);

      taskIdCounter++;
    }
  });
});
