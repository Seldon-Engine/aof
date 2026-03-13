/**
 * Tests for trace-helpers.ts — captureTraceSafely wrapper.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../trace/trace-writer.js", () => ({
  captureTrace: vi.fn().mockResolvedValue({ success: true }),
}));

import { captureTrace } from "../../trace/trace-writer.js";
import { captureTraceSafely } from "../trace-helpers.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";

describe("captureTraceSafely", () => {
  const mockStore = {} as ITaskStore;
  const mockLogger = {} as EventLogger;

  beforeEach(() => {
    vi.mocked(captureTrace).mockReset().mockResolvedValue({
      success: true,
      noopDetected: false,
      tracePath: "/tmp/trace-1.json",
    });
  });

  it("calls captureTrace when sessionId and agentId are present", async () => {
    await captureTraceSafely({
      taskId: "task-1",
      sessionId: "session-1",
      agentId: "agent-1",
      durationMs: 5000,
      store: mockStore,
      logger: mockLogger,
    });

    expect(captureTrace).toHaveBeenCalledOnce();
    expect(captureTrace).toHaveBeenCalledWith({
      taskId: "task-1",
      sessionId: "session-1",
      agentId: "agent-1",
      durationMs: 5000,
      store: mockStore,
      logger: mockLogger,
      debug: false,
    });
  });

  it("skips capture when sessionId is missing (no-op, no error)", async () => {
    await captureTraceSafely({
      taskId: "task-1",
      agentId: "agent-1",
      durationMs: 5000,
      store: mockStore,
      logger: mockLogger,
    });

    expect(captureTrace).not.toHaveBeenCalled();
  });

  it("skips capture when agentId is missing (no-op, no error)", async () => {
    await captureTraceSafely({
      taskId: "task-1",
      sessionId: "session-1",
      durationMs: 5000,
      store: mockStore,
      logger: mockLogger,
    });

    expect(captureTrace).not.toHaveBeenCalled();
  });

  it("reads debug flag from currentTask frontmatter metadata", async () => {
    const currentTask = {
      frontmatter: { metadata: { debug: true } },
    } as any;

    await captureTraceSafely({
      taskId: "task-1",
      sessionId: "session-1",
      agentId: "agent-1",
      durationMs: 5000,
      store: mockStore,
      logger: mockLogger,
      currentTask,
    });

    expect(captureTrace).toHaveBeenCalledWith(
      expect.objectContaining({ debug: true }),
    );
  });

  it("catches and logs errors at warn level, never throws", async () => {
    vi.mocked(captureTrace).mockRejectedValue(new Error("trace boom"));

    // Should not throw
    await expect(
      captureTraceSafely({
        taskId: "task-1",
        sessionId: "session-1",
        agentId: "agent-1",
        durationMs: 5000,
        store: mockStore,
        logger: mockLogger,
      }),
    ).resolves.toBeUndefined();
  });
});
