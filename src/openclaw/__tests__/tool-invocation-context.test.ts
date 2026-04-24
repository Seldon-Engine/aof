import { describe, expect, it } from "vitest";
import { OpenClawToolInvocationContextStore } from "../tool-invocation-context.js";

describe("OpenClawToolInvocationContextStore", () => {
  it("clears stored session routes on session end", () => {
    const store = new OpenClawToolInvocationContextStore();

    store.captureMessageRoute({
      sessionKey: "agent:main:telegram:group:42",
      target: "telegram:-10042",
      channel: "telegram",
    });
    store.captureToolCall({
      name: "aof_dispatch",
      id: "tool-call-1",
      sessionKey: "agent:main:telegram:group:42",
    });

    store.clearSessionRoute({
      sessionKey: "agent:main:telegram:group:42",
    });
    store.captureToolCall({
      name: "aof_dispatch",
      id: "tool-call-2",
      sessionKey: "agent:main:telegram:group:42",
    });

    expect(store.consumeToolCall("tool-call-1")).toMatchObject({
      replyTarget: "telegram:-10042",
    });
    expect(store.consumeToolCall("tool-call-2")).toMatchObject({
      sessionKey: "agent:main:telegram:group:42",
      replyTarget: undefined,
    });
  });

  it("expires stale routes and tool calls after the configured TTL", () => {
    let now = 1_000;
    const store = new OpenClawToolInvocationContextStore({
      routeTtlMs: 100,
      now: () => now,
    });

    store.captureMessageRoute({
      sessionKey: "agent:main:telegram:group:42",
      target: "telegram:-10042",
      channel: "telegram",
    });
    store.captureToolCall({
      name: "aof_dispatch",
      id: "tool-call-1",
      sessionKey: "agent:main:telegram:group:42",
    });

    now += 101;

    expect(store.consumeToolCall("tool-call-1")).toBeUndefined();
  });
});

describe("OpenClawToolInvocationContextStore — Phase 44 default TTL removal", () => {
  // RED: Plan 05 (Wave 2) owns the actual TTL bump. Today's default TTL is
  // 1h (DEFAULT_ROUTE_TTL_MS = 60 * 60 * 1000 at tool-invocation-context.ts:24),
  // which is too short to cover dispatch→completion windows for typical
  // orchestration work. Plan 05 will either bump the default to 24h (per
  // 44-RESEARCH.md §11 Q2) or remove time-based eviction entirely, relying
  // on the existing LRU cap + session_end cleanup as the only bounds.
  //
  // The existing "expires stale routes and tool calls after the configured
  // TTL" test above intentionally stays green — it uses an explicit
  // `routeTtlMs: 100` override. Plan 05 must preserve the override seam so
  // unit tests can still exercise finite-TTL behaviour.
  //
  // NOTE: A second RED test for a session-end-style `clearSessionRoute`
  // drop is intentionally omitted — the current public API has no
  // `consumeSessionRoute(sessionKey)` method, so there is no clean way to
  // observe the by-sessionKey map from outside the class. The sibling
  // "clears stored session routes on session end" test above already
  // exercises the session-end path indirectly via a subsequent captureToolCall.

  it("default-constructor store retains a captured tool-call past 24h of simulated clock time", () => {
    let now = 1_000;
    const store = new OpenClawToolInvocationContextStore({ now: () => now });
    store.captureToolCall({
      name: "aof_dispatch",
      id: "tc-longlived",
      sessionKey: "agent:main:telegram:group:42",
      agentId: "main",
    });
    now += 25 * 60 * 60 * 1000; // 25 hours
    const recovered = store.consumeToolCall("tc-longlived");
    expect(recovered).toBeDefined();
    expect(recovered?.sessionKey).toBe("agent:main:telegram:group:42");
  });
});
