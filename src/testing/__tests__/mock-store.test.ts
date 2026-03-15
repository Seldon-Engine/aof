/**
 * Tests for createMockStore factory.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockStore } from "../mock-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { Task } from "../../schemas/task.js";

describe("createMockStore", () => {
  it("returns an object satisfying ITaskStore", () => {
    const store = createMockStore();
    // Type-level check: assigning to ITaskStore must compile
    const _typed: ITaskStore = store;
    expect(_typed).toBeDefined();
  });

  it("has projectRoot, projectId, tasksDir as string properties", () => {
    const store = createMockStore();
    expect(typeof store.projectRoot).toBe("string");
    expect(typeof store.projectId).toBe("string");
    expect(typeof store.tasksDir).toBe("string");
  });

  it("has all ITaskStore methods as vi.fn() stubs", () => {
    const store = createMockStore();
    const methodNames = [
      "init", "create", "get", "getByPrefix", "list", "countByStatus",
      "transition", "cancel", "updateBody", "update", "delete", "lint",
      "getTaskInputs", "getTaskOutputs", "writeTaskOutput",
      "addDep", "removeDep", "block", "unblock", "save", "saveToPath",
    ] as const;

    for (const name of methodNames) {
      expect(vi.isMockFunction(store[name]), `${name} should be a mock function`).toBe(true);
    }
  });

  it("methods return appropriate defaults", async () => {
    const store = createMockStore();
    expect(await store.get("x")).toBeUndefined();
    expect(await store.getByPrefix("x")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(await store.countByStatus()).toEqual({});
    expect(await store.delete("x")).toBe(false);
    expect(await store.lint()).toEqual([]);
    expect(await store.getTaskInputs("x")).toEqual([]);
    expect(await store.getTaskOutputs("x")).toEqual([]);
  });

  it("pre-seeds get/list when tasks provided", async () => {
    const task1 = {
      frontmatter: {
        schemaVersion: 2,
        id: "TASK-2026-01-01-001",
        project: "test",
        title: "Test task",
        status: "ready",
        priority: "normal",
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
        createdBy: "test",
        routing: { tags: [] },
        history: [],
        dependsOn: [],
        contentHash: "abc123",
      },
      body: "",
      path: "/tmp/test",
    } as Task;

    const store = createMockStore({ tasks: [task1] });

    expect(await store.get("TASK-2026-01-01-001")).toEqual(task1);
    expect(await store.get("nonexistent")).toBeUndefined();
    expect(await store.list()).toEqual([task1]);
    expect(await store.getByPrefix("TASK-2026-01")).toEqual(task1);
  });

  it("pre-seeds countByStatus when tasks provided", async () => {
    const makeTask = (id: string, status: string) => ({
      frontmatter: {
        schemaVersion: 2,
        id,
        project: "test",
        title: "Test",
        status,
        priority: "normal",
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
        createdBy: "test",
        routing: { tags: [] },
        history: [],
        dependsOn: [],
        contentHash: "abc",
      },
      body: "",
      path: "/tmp/test",
    }) as Task;

    const store = createMockStore({
      tasks: [makeTask("TASK-2026-01-01-001", "ready"), makeTask("TASK-2026-01-01-002", "ready"), makeTask("TASK-2026-01-01-003", "done")],
    });

    expect(await store.countByStatus()).toEqual({ ready: 2, done: 1 });
  });

  it("applies partial overrides", async () => {
    const customList = vi.fn().mockResolvedValue([{ id: "custom" }]);
    const store = createMockStore({ overrides: { list: customList } });
    expect(await store.list()).toEqual([{ id: "custom" }]);
  });
});
