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
