/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers decision D-10: adapter selection at dispatch time.
 *   - In "plugin-bridge" mode: delegate to the primary (PluginBridgeAdapter)
 *     when a plugin is attached, otherwise return the D-12 hold sentinel.
 *   - In "standalone" mode: delegate to the fallback (StandaloneAdapter) when
 *     no plugin; prefer primary if one has registered (plugin overrides).
 *
 * RED anchor: imports `SelectingAdapter` from "../selecting-adapter.js" which
 * does not yet exist. Wave 2 lands `src/dispatch/selecting-adapter.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  GatewayAdapter,
  SpawnResult,
  SessionStatus,
  TaskContext,
  AgentRunOutcome,
} from "../executor.js";
import { SelectingAdapter } from "../selecting-adapter.js"; // INTENTIONALLY MISSING — Wave 2 creates this (D-10).

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

function makeMockAdapter(label: string, spawnResult: SpawnResult): GatewayAdapter {
  return {
    spawnSession: vi.fn(async (_ctx, _opts) => ({ ...spawnResult, sessionId: `${label}-sess` })),
    getSessionStatus: vi.fn(
      async (sessionId: string): Promise<SessionStatus> => ({ sessionId, alive: true }),
    ),
    forceCompleteSession: vi.fn(async () => undefined),
  };
}

function makeRegistry(hasPlugin: boolean): { hasActivePlugin: () => boolean } {
  return { hasActivePlugin: () => hasPlugin };
}

describe("SelectingAdapter (D-10 adapter selection)", () => {
  it("D-10 plugin-bridge + active plugin → delegates to primary", async () => {
    const primary = makeMockAdapter("primary", { success: true });
    const fallback = makeMockAdapter("fallback", { success: true });
    const registry = makeRegistry(true);

    const selector = new SelectingAdapter({
      primary,
      fallback,
      registry: registry as never,
      mode: "plugin-bridge",
    });

    const result = await selector.spawnSession(makeCtx());
    expect(result.success).toBe(true);
    expect(primary.spawnSession).toHaveBeenCalledTimes(1);
    expect(fallback.spawnSession).not.toHaveBeenCalled();
  });

  it("D-12 plugin-bridge + no plugin → returns { success: false, error: 'no-plugin-attached' }", async () => {
    const primary = makeMockAdapter("primary", { success: true });
    const fallback = makeMockAdapter("fallback", { success: true });
    const registry = makeRegistry(false);

    const selector = new SelectingAdapter({
      primary,
      fallback,
      registry: registry as never,
      mode: "plugin-bridge",
    });

    const result = await selector.spawnSession(makeCtx());
    expect(result).toEqual({ success: false, error: "no-plugin-attached" });
    // D-12 requires NOT falling through to fallback in plugin-bridge mode.
    expect(fallback.spawnSession).not.toHaveBeenCalled();
    expect(primary.spawnSession).not.toHaveBeenCalled();
  });

  it("D-10 standalone + no plugin → delegates to fallback (daemon-only install)", async () => {
    const primary = makeMockAdapter("primary", { success: true });
    const fallback = makeMockAdapter("fallback", { success: true });
    const registry = makeRegistry(false);

    const selector = new SelectingAdapter({
      primary,
      fallback,
      registry: registry as never,
      mode: "standalone",
    });

    const result = await selector.spawnSession(makeCtx());
    expect(result.success).toBe(true);
    expect(fallback.spawnSession).toHaveBeenCalledTimes(1);
    expect(primary.spawnSession).not.toHaveBeenCalled();
  });

  it("D-10 standalone + active plugin → prefers primary (plugin overrides)", async () => {
    const primary = makeMockAdapter("primary", { success: true });
    const fallback = makeMockAdapter("fallback", { success: true });
    const registry = makeRegistry(true);

    const selector = new SelectingAdapter({
      primary,
      fallback,
      registry: registry as never,
      mode: "standalone",
    });

    const result = await selector.spawnSession(makeCtx());
    expect(result.success).toBe(true);
    expect(primary.spawnSession).toHaveBeenCalledTimes(1);
    expect(fallback.spawnSession).not.toHaveBeenCalled();
  });

  it("D-10 getSessionStatus routes by plugin attachment", async () => {
    const primary = makeMockAdapter("primary", { success: true });
    const fallback = makeMockAdapter("fallback", { success: true });

    const withPlugin = new SelectingAdapter({
      primary,
      fallback,
      registry: makeRegistry(true) as never,
      mode: "plugin-bridge",
    });
    await withPlugin.getSessionStatus("s-1");
    expect(primary.getSessionStatus).toHaveBeenCalledWith("s-1");

    const withoutPlugin = new SelectingAdapter({
      primary,
      fallback,
      registry: makeRegistry(false) as never,
      mode: "standalone",
    });
    await withoutPlugin.getSessionStatus("s-2");
    expect(fallback.getSessionStatus).toHaveBeenCalledWith("s-2");
  });

  it("D-10 forceCompleteSession routes by plugin attachment", async () => {
    const primary = makeMockAdapter("primary", { success: true });
    const fallback = makeMockAdapter("fallback", { success: true });

    const withPlugin = new SelectingAdapter({
      primary,
      fallback,
      registry: makeRegistry(true) as never,
      mode: "plugin-bridge",
    });
    await withPlugin.forceCompleteSession("s-1");
    expect(primary.forceCompleteSession).toHaveBeenCalledWith("s-1");

    const withoutPlugin = new SelectingAdapter({
      primary,
      fallback,
      registry: makeRegistry(false) as never,
      mode: "standalone",
    });
    await withoutPlugin.forceCompleteSession("s-2");
    expect(fallback.forceCompleteSession).toHaveBeenCalledWith("s-2");
  });

  // Type-level sanity: SelectingAdapter implements the full GatewayAdapter contract.
  // If this reference compiles, Wave 2's adapter conforms.
  it("type-check: SelectingAdapter satisfies GatewayAdapter", () => {
    const primary = makeMockAdapter("primary", { success: true });
    const fallback = makeMockAdapter("fallback", { success: true });
    const selector: GatewayAdapter = new SelectingAdapter({
      primary,
      fallback,
      registry: makeRegistry(true) as never,
      mode: "plugin-bridge",
    });
    expect(typeof selector.spawnSession).toBe("function");
    // Touch the unused type to silence TS "unused" warnings.
    const _outcome: AgentRunOutcome = {
      taskId: "t",
      sessionId: "s",
      success: true,
      aborted: false,
      durationMs: 1,
    };
    expect(_outcome.success).toBe(true);
  });
});
