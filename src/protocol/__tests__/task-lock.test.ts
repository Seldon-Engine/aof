import { describe, it, expect } from "vitest";
import { InMemoryTaskLockManager } from "../task-lock.js";

describe("InMemoryTaskLockManager", () => {
  it("executes functions serially for the same taskId", async () => {
    const lockManager = new InMemoryTaskLockManager();
    const execution: string[] = [];
    
    const task1 = lockManager.withLock("task-1", async () => {
      execution.push("task-1-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      execution.push("task-1-end");
      return "result-1";
    });

    const task2 = lockManager.withLock("task-1", async () => {
      execution.push("task-2-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      execution.push("task-2-end");
      return "result-2";
    });

    const results = await Promise.all([task1, task2]);

    expect(results).toEqual(["result-1", "result-2"]);
    expect(execution).toEqual([
      "task-1-start",
      "task-1-end",
      "task-2-start",
      "task-2-end",
    ]);
  });

  it("allows concurrent execution for different taskIds", async () => {
    const lockManager = new InMemoryTaskLockManager();
    const execution: string[] = [];

    const task1 = lockManager.withLock("task-1", async () => {
      execution.push("task-1-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      execution.push("task-1-end");
    });

    const task2 = lockManager.withLock("task-2", async () => {
      execution.push("task-2-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      execution.push("task-2-end");
    });

    await Promise.all([task1, task2]);

    // task-2 should start before task-1 ends (concurrent)
    expect(execution.indexOf("task-2-start")).toBeLessThan(execution.indexOf("task-1-end"));
    expect(execution).toContain("task-1-start");
    expect(execution).toContain("task-1-end");
    expect(execution).toContain("task-2-start");
    expect(execution).toContain("task-2-end");
  });

  it("propagates errors and continues processing", async () => {
    const lockManager = new InMemoryTaskLockManager();
    const execution: string[] = [];

    const task1 = lockManager.withLock("task-1", async () => {
      execution.push("task-1-start");
      throw new Error("task-1-error");
    });

    const task2 = lockManager.withLock("task-1", async () => {
      execution.push("task-2-start");
      return "result-2";
    });

    await expect(task1).rejects.toThrow("task-1-error");
    const result2 = await task2;

    expect(result2).toBe("result-2");
    expect(execution).toEqual(["task-1-start", "task-2-start"]);
  });

  it("cleans up locks after completion", async () => {
    const lockManager = new InMemoryTaskLockManager();
    
    await lockManager.withLock("task-1", async () => {
      return "done";
    });

    // Access private property for verification (testing only)
    const locks = (lockManager as any).locks as Map<string, Promise<unknown>>;
    expect(locks.has("task-1")).toBe(false);
  });

  it("handles multiple serial operations", async () => {
    const lockManager = new InMemoryTaskLockManager();
    const execution: number[] = [];

    const operations = Array.from({ length: 5 }, (_, i) =>
      lockManager.withLock("task-1", async () => {
        execution.push(i);
        await new Promise((resolve) => setTimeout(resolve, 5));
      })
    );

    await Promise.all(operations);

    expect(execution).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns the result of the wrapped function", async () => {
    const lockManager = new InMemoryTaskLockManager();
    
    const result = await lockManager.withLock("task-1", async () => {
      return { success: true, data: "test-data" };
    });

    expect(result).toEqual({ success: true, data: "test-data" });
  });
});
