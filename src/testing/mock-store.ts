/**
 * Mock task store factory for testing.
 *
 * Returns a fully typed ITaskStore where every method is a vi.fn() stub.
 * Optionally pre-seeds data for get/list/countByStatus/getByPrefix.
 */

import { vi } from "vitest";
import type { ITaskStore } from "../store/interfaces.js";
import type { Task } from "../schemas/task.js";

/** ITaskStore with all methods replaced by vi.fn() mocks. */
export type MockTaskStore = {
  -readonly [K in keyof ITaskStore]: ITaskStore[K] extends (...args: infer A) => infer R
    ? ReturnType<typeof vi.fn<(...args: A) => R>>
    : ITaskStore[K];
};

export interface CreateMockStoreOptions {
  /** Pre-seed tasks for get/list/getByPrefix/countByStatus. */
  tasks?: Task[];
  /** Override specific methods after default creation. */
  overrides?: Partial<ITaskStore>;
}

export function createMockStore(opts?: CreateMockStoreOptions): MockTaskStore {
  const tasks = opts?.tasks ?? [];

  const store = {
    projectRoot: "/tmp/mock-project",
    projectId: "mock",
    tasksDir: "/tmp/mock-project/tasks",

    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    create: vi.fn<() => Promise<Task>>().mockResolvedValue(undefined as unknown as Task),
    get: vi.fn<(id: string) => Promise<Task | undefined>>().mockImplementation(
      async (id: string) => tasks.find((t) => t.frontmatter.id === id),
    ),
    getByPrefix: vi.fn<(prefix: string) => Promise<Task | undefined>>().mockImplementation(
      async (prefix: string) => tasks.find((t) => t.frontmatter.id.startsWith(prefix)),
    ),
    list: vi.fn<() => Promise<Task[]>>().mockResolvedValue(tasks),
    countByStatus: vi.fn<() => Promise<Record<string, number>>>().mockImplementation(async () => {
      const counts: Record<string, number> = {};
      for (const t of tasks) {
        counts[t.frontmatter.status] = (counts[t.frontmatter.status] ?? 0) + 1;
      }
      return counts;
    }),
    transition: vi.fn<() => Promise<Task>>().mockResolvedValue(undefined as unknown as Task),
    cancel: vi.fn<() => Promise<Task>>().mockResolvedValue(undefined as unknown as Task),
    updateBody: vi.fn<() => Promise<Task>>().mockResolvedValue(undefined as unknown as Task),
    update: vi.fn<() => Promise<Task>>().mockResolvedValue(undefined as unknown as Task),
    delete: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    lint: vi.fn<() => Promise<Array<{ task: Task; issue: string }>>>().mockResolvedValue([]),
    getTaskInputs: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    getTaskOutputs: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    writeTaskOutput: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    addDep: vi.fn<() => Promise<Task>>().mockResolvedValue(undefined as unknown as Task),
    removeDep: vi.fn<() => Promise<Task>>().mockResolvedValue(undefined as unknown as Task),
    block: vi.fn<() => Promise<Task>>().mockResolvedValue(undefined as unknown as Task),
    unblock: vi.fn<() => Promise<Task>>().mockResolvedValue(undefined as unknown as Task),
    save: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    saveToPath: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } satisfies ITaskStore as MockTaskStore;

  // Apply overrides
  if (opts?.overrides) {
    Object.assign(store, opts.overrides);
  }

  return store;
}
