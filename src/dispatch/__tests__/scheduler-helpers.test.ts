import { describe, it, expect } from "vitest";
import { buildTaskStats } from "../scheduler-helpers.js";
import type { Task } from "../../schemas/task.js";

/**
 * Minimal mock task — only frontmatter.status is needed by buildTaskStats.
 */
function mockTask(status: string): Task {
  return {
    frontmatter: {
      id: `task-${status}-${Math.random().toString(36).slice(2, 6)}`,
      title: `Test task (${status})`,
      status: status as Task["frontmatter"]["status"],
      priority: "normal",
      routing: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: "test",
      dependsOn: [],
    },
    body: "",
  } as Task;
}

describe("buildTaskStats", () => {
  it("returns correct counts for all 8 statuses", () => {
    const tasks: Task[] = [
      mockTask("backlog"),
      mockTask("ready"),
      mockTask("in-progress"),
      mockTask("blocked"),
      mockTask("review"),
      mockTask("done"),
      mockTask("cancelled"),
      mockTask("deadletter"),
    ];

    const stats = buildTaskStats(tasks);

    expect(stats.backlog).toBe(1);
    expect(stats.ready).toBe(1);
    expect(stats.inProgress).toBe(1);
    expect(stats.blocked).toBe(1);
    expect(stats.review).toBe(1);
    expect(stats.done).toBe(1);
    expect(stats.cancelled).toBe(1);
    expect(stats.deadletter).toBe(1);
    expect(stats.total).toBe(8);
  });

  it("counts multiple cancelled and deadletter tasks", () => {
    const tasks: Task[] = [
      mockTask("cancelled"),
      mockTask("cancelled"),
      mockTask("cancelled"),
      mockTask("deadletter"),
      mockTask("deadletter"),
      mockTask("done"),
    ];

    const stats = buildTaskStats(tasks);

    expect(stats.cancelled).toBe(3);
    expect(stats.deadletter).toBe(2);
    expect(stats.done).toBe(1);
    expect(stats.total).toBe(6);
  });

  it("total equals sum of all 8 status fields", () => {
    const tasks: Task[] = [
      mockTask("backlog"),
      mockTask("backlog"),
      mockTask("ready"),
      mockTask("in-progress"),
      mockTask("blocked"),
      mockTask("review"),
      mockTask("done"),
      mockTask("done"),
      mockTask("done"),
      mockTask("cancelled"),
      mockTask("deadletter"),
    ];

    const stats = buildTaskStats(tasks);

    const sum =
      stats.backlog +
      stats.ready +
      stats.inProgress +
      stats.blocked +
      stats.review +
      stats.done +
      stats.cancelled +
      stats.deadletter;

    expect(sum).toBe(stats.total);
  });

  it("returns zeroes for empty task list", () => {
    const stats = buildTaskStats([]);

    expect(stats.total).toBe(0);
    expect(stats.cancelled).toBe(0);
    expect(stats.deadletter).toBe(0);
  });
});
