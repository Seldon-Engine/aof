/**
 * Tests for callback-helpers.ts — deliverAllCallbacksSafely wrapper.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../callback-delivery.js", () => ({
  deliverCallbacks: vi.fn().mockResolvedValue(undefined),
  deliverAllGranularityCallbacks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../store/subscription-store.js", () => ({
  SubscriptionStore: vi.fn().mockImplementation(() => ({
    list: vi.fn().mockResolvedValue([]),
  })),
}));

import { deliverCallbacks, deliverAllGranularityCallbacks } from "../callback-delivery.js";
import { SubscriptionStore } from "../../store/subscription-store.js";
import { deliverAllCallbacksSafely } from "../callback-helpers.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { GatewayAdapter } from "../executor.js";
import type { EventLogger } from "../../events/logger.js";

describe("deliverAllCallbacksSafely", () => {
  const mockStore = {
    tasksDir: "/tmp/tasks",
    get: vi.fn().mockResolvedValue({ frontmatter: { status: "done" } }),
  } as unknown as ITaskStore;
  const mockExecutor = {} as GatewayAdapter;
  const mockLogger = {} as EventLogger;

  beforeEach(() => {
    vi.mocked(deliverCallbacks).mockReset().mockResolvedValue(undefined);
    vi.mocked(deliverAllGranularityCallbacks).mockReset().mockResolvedValue(undefined);
    vi.mocked(SubscriptionStore).mockClear();
  });

  it("constructs SubscriptionStore and calls both delivery functions", async () => {
    await deliverAllCallbacksSafely({
      taskId: "task-1",
      store: mockStore,
      executor: mockExecutor,
      logger: mockLogger,
    });

    expect(SubscriptionStore).toHaveBeenCalledOnce();
    expect(deliverCallbacks).toHaveBeenCalledOnce();
    expect(deliverAllGranularityCallbacks).toHaveBeenCalledOnce();

    // Verify taskId is passed through
    const dcArgs = vi.mocked(deliverCallbacks).mock.calls[0]![0];
    expect(dcArgs.taskId).toBe("task-1");
  });

  it("catches deliverCallbacks error and still calls deliverAllGranularityCallbacks", async () => {
    vi.mocked(deliverCallbacks).mockRejectedValue(new Error("deliver boom"));

    await expect(
      deliverAllCallbacksSafely({
        taskId: "task-1",
        store: mockStore,
        executor: mockExecutor,
        logger: mockLogger,
      }),
    ).resolves.toBeUndefined();

    // deliverAllGranularityCallbacks should still be called
    expect(deliverAllGranularityCallbacks).toHaveBeenCalledOnce();
  });

  it("catches deliverAllGranularityCallbacks error and resolves", async () => {
    vi.mocked(deliverAllGranularityCallbacks).mockRejectedValue(new Error("gran boom"));

    await expect(
      deliverAllCallbacksSafely({
        taskId: "task-1",
        store: mockStore,
        executor: mockExecutor,
        logger: mockLogger,
      }),
    ).resolves.toBeUndefined();
  });

  it("handles SubscriptionStore construction failure gracefully", async () => {
    vi.mocked(SubscriptionStore).mockImplementation(() => {
      throw new Error("constructor boom");
    });

    await expect(
      deliverAllCallbacksSafely({
        taskId: "task-1",
        store: mockStore,
        executor: mockExecutor,
        logger: mockLogger,
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws even when both delivery functions fail", async () => {
    vi.mocked(deliverCallbacks).mockRejectedValue(new Error("boom 1"));
    vi.mocked(deliverAllGranularityCallbacks).mockRejectedValue(new Error("boom 2"));

    await expect(
      deliverAllCallbacksSafely({
        taskId: "task-1",
        store: mockStore,
        executor: mockExecutor,
        logger: mockLogger,
      }),
    ).resolves.toBeUndefined();
  });
});
