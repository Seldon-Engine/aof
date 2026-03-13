import { describe, it, expect, vi } from "vitest";
import { withPermissions } from "../permissions.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { ToolContext } from "../../tools/aof-tools.js";
import { EventLogger } from "../../events/logger.js";

describe("withPermissions", () => {
  const mockStore = {} as ITaskStore;
  const mockPermissionStore = {} as ITaskStore;
  const mockLogger = {} as EventLogger;

  const resolveProjectStore = vi.fn((projectId?: string) => mockStore);
  const getStoreForActor = vi.fn(async (actor?: string, baseStore?: ITaskStore) => mockPermissionStore);

  it("extracts actor and project from params", async () => {
    const handler = vi.fn(async (ctx: ToolContext, input: Record<string, unknown>) => ({
      success: true,
    }));

    const wrapped = withPermissions(handler, resolveProjectStore, getStoreForActor, mockLogger);

    await wrapped("tool-id", { actor: "swe-backend", project: "my-project", taskId: "TASK-001" });

    expect(resolveProjectStore).toHaveBeenCalledWith("my-project");
    expect(getStoreForActor).toHaveBeenCalledWith("swe-backend", mockStore);
  });

  it("calls handler with ToolContext containing resolved store", async () => {
    const handler = vi.fn(async (ctx: ToolContext, input: Record<string, unknown>) => ({
      result: "ok",
    }));

    const wrapped = withPermissions(handler, resolveProjectStore, getStoreForActor, mockLogger);

    await wrapped("tool-id", { actor: "swe-backend", taskId: "TASK-001" });

    expect(handler).toHaveBeenCalledOnce();
    const [ctx, input] = handler.mock.calls[0]!;
    expect(ctx.store).toBe(mockPermissionStore);
    expect(ctx.logger).toBe(mockLogger);
    expect(input.taskId).toBe("TASK-001");
  });

  it("wraps result with content array", async () => {
    const handler = vi.fn(async () => ({ foo: "bar" }));

    const wrapped = withPermissions(handler, resolveProjectStore, getStoreForActor, mockLogger);

    const result = await wrapped("tool-id", {});

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ foo: "bar" }, null, 2) }],
    });
  });

  it("passes project as projectId in ToolContext", async () => {
    const handler = vi.fn(async (ctx: ToolContext, _input: Record<string, unknown>) => ctx.projectId);

    const wrapped = withPermissions(handler, resolveProjectStore, getStoreForActor, mockLogger);

    await wrapped("tool-id", { project: "proj-123" });

    const [ctx] = handler.mock.calls[0]!;
    expect(ctx.projectId).toBe("proj-123");
  });

  it("handles missing actor and project gracefully", async () => {
    const handler = vi.fn(async (ctx: ToolContext, _input: Record<string, unknown>) => ({
      store: ctx.store,
    }));

    const wrapped = withPermissions(handler, resolveProjectStore, getStoreForActor, mockLogger);

    await wrapped("tool-id", { taskId: "TASK-001" });

    expect(resolveProjectStore).toHaveBeenCalledWith(undefined);
    expect(getStoreForActor).toHaveBeenCalledWith(undefined, mockStore);
  });
});
