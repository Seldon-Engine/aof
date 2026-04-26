/**
 * Project scoping tests — ToolContext propagation and store resolution.
 *
 * The "Participant filtering in dispatch" describe block (4 tests for PROJ-03)
 * was removed 2026-04-26 along with the project.participants field.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";

describe("Project scoping", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-project-scope-"));
    store = new FilesystemTaskStore(tmpDir, { projectId: "test-project" });
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("ToolContext projectId propagation", () => {
    it("resolves project-scoped store when projectId matches", () => {
      // Simulates the resolveProjectStore logic from adapter.ts
      const globalStore = { projectId: "global" } as ITaskStore;
      const projectAStore = { projectId: "project-a" } as ITaskStore;
      const projectStores = new Map<string, ITaskStore>([
        ["project-a", projectAStore],
      ]);

      // Resolve with matching project ID
      const resolveProjectStore = (projectId?: string): ITaskStore => {
        if (projectId && projectStores.has(projectId)) {
          return projectStores.get(projectId)!;
        }
        return globalStore;
      };

      expect(resolveProjectStore("project-a")).toBe(projectAStore);
      expect(resolveProjectStore("project-a").projectId).toBe("project-a");
    });

    it("falls back to global store when project ID not found", () => {
      const globalStore = { projectId: "global" } as ITaskStore;
      const projectStores = new Map<string, ITaskStore>();

      const resolveProjectStore = (projectId?: string): ITaskStore => {
        if (projectId && projectStores.has(projectId)) {
          return projectStores.get(projectId)!;
        }
        return globalStore;
      };

      expect(resolveProjectStore("nonexistent")).toBe(globalStore);
      expect(resolveProjectStore(undefined)).toBe(globalStore);
    });
  });

});
