/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers decision D-10: PluginBridgeAdapter implements GatewayAdapter by
 * enqueuing SpawnRequests onto the shared queue (consumed by the plugin's
 * long-poll). When no plugin is attached, returns the D-12 sentinel
 * `{ success: false, error: "no-plugin-attached" }`. When the plugin posts
 * back via `/v1/spawns/{id}/result`, the adapter invokes the registered
 * `onRunComplete` callback.
 *
 * RED anchor: imports `PluginBridgeAdapter` from "../plugin-bridge-adapter.js"
 * which does not yet exist. Wave 2 lands `src/dispatch/plugin-bridge-adapter.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import type { GatewayAdapter, TaskContext } from "../executor.js";
import { PluginBridgeAdapter } from "../plugin-bridge-adapter.js"; // INTENTIONALLY MISSING — Wave 2 creates this (D-10).

function makeCtx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: "task-1",
    taskPath: "/tmp/tasks/ready/task-1",
    agent: "swe-backend",
    priority: "normal",
    routing: {},
    ...overrides,
  };
}

/** Minimal queue stub matching the shape Wave 2 SpawnQueue exposes. */
function makeQueueStub(): {
  enqueue: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  tryClaim: ReturnType<typeof vi.fn>;
} {
  const pending: Array<{ id: string }> = [];
  return {
    enqueue: vi.fn((req: Record<string, unknown>) => {
      const id = `spawn-${pending.length + 1}`;
      pending.push({ id });
      return { id, ...req };
    }),
    claim: vi.fn(() => pending.shift()),
    tryClaim: vi.fn(() => true),
  };
}

function makeRegistry(hasPlugin: boolean): { hasActivePlugin: () => boolean } {
  return { hasActivePlugin: () => hasPlugin };
}

describe("PluginBridgeAdapter (D-10 GatewayAdapter conformance)", () => {
  it("D-10: constructs and implements GatewayAdapter type", () => {
    const queue = makeQueueStub();
    const registry = makeRegistry(true);
    const adapter: GatewayAdapter = new PluginBridgeAdapter(queue as never, registry as never);
    expect(typeof adapter.spawnSession).toBe("function");
    expect(typeof adapter.getSessionStatus).toBe("function");
    expect(typeof adapter.forceCompleteSession).toBe("function");
  });

  it("D-12: spawnSession with no active plugin returns { success:false, error:'no-plugin-attached' }", async () => {
    const queue = makeQueueStub();
    const registry = makeRegistry(false);
    const adapter = new PluginBridgeAdapter(queue as never, registry as never);

    const result = await adapter.spawnSession(makeCtx());
    expect(result).toEqual({ success: false, error: "no-plugin-attached" });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("D-10: spawnSession with active plugin enqueues SpawnRequest and returns { success:true }", async () => {
    const queue = makeQueueStub();
    const registry = makeRegistry(true);
    const adapter = new PluginBridgeAdapter(queue as never, registry as never);

    const result = await adapter.spawnSession(makeCtx({ taskId: "task-42" }));

    expect(result.success).toBe(true);
    expect(result.sessionId).toBeTruthy();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);

    // Verify that key TaskContext fields are forwarded into the spawn request.
    const [enqueued] = queue.enqueue.mock.calls[0]!;
    expect(enqueued).toMatchObject({
      taskId: "task-42",
      agent: "swe-backend",
      priority: "normal",
    });
  });

  it("D-10: deliverResult invokes the onRunComplete callback with AgentRunOutcome", async () => {
    const queue = makeQueueStub();
    const registry = makeRegistry(true);
    const adapter = new PluginBridgeAdapter(queue as never, registry as never);

    const onRunComplete = vi.fn();
    const { sessionId } = await adapter.spawnSession(makeCtx({ taskId: "task-cb" }), {
      onRunComplete,
    });

    // Plugin posts spawn result back via the IPC route; adapter exposes
    // deliverResult(id, result, taskId) used by the daemon's result handler.
    await adapter.deliverResult(
      sessionId!,
      {
        sessionId: "real-session-123",
        success: true,
        aborted: false,
        durationMs: 500,
      },
      "task-cb",
    );

    expect(onRunComplete).toHaveBeenCalledTimes(1);
    const [outcome] = onRunComplete.mock.calls[0]!;
    expect(outcome).toMatchObject({
      taskId: "task-cb",
      sessionId: "real-session-123",
      success: true,
      aborted: false,
      durationMs: 500,
    });
  });

  it("D-06: correlationId + timeoutMs flow into enqueued SpawnRequest unchanged", async () => {
    const queue = makeQueueStub();
    const registry = makeRegistry(true);
    const adapter = new PluginBridgeAdapter(queue as never, registry as never);

    await adapter.spawnSession(makeCtx({ taskId: "task-corr" }), {
      correlationId: "corr-abc-123",
      timeoutMs: 45_000,
    });

    const [enqueued] = queue.enqueue.mock.calls[0]!;
    expect(enqueued).toMatchObject({
      taskId: "task-corr",
      correlationId: "corr-abc-123",
      timeoutMs: 45_000,
    });
  });
});
