/**
 * Phase 46 / Bug 2C — plugin-side defense-in-depth actor fallback.
 *
 * `mergeDispatchNotificationRecipient` is the only plugin-side pre-handler
 * transform for `aof_dispatch`. After Phase 46 it falls back `params.actor`
 * to `captured.actor` (the agentId from OpenClaw's before_tool_call event)
 * when the caller didn't supply one explicitly.
 *
 * Defense-in-depth complements the daemon-side fix in
 * `src/ipc/routes/invoke-tool.ts`: even if the agent doesn't pass
 * `params.actor`, the OpenClaw gateway DID emit `agentId` in the
 * before_tool_call event, so we can populate `params.actor` from the
 * captured invocation context BEFORE the IPC envelope is built.
 *
 * Behavioral note: the function now fetches `consumeToolCall(toolCallId)`
 * BEFORE the `notifyOnCompletion === false` early-return, so the consume
 * side-effect fires regardless of notification preference. This is the
 * intended Phase 46 reorder — actor injection must run even when
 * notifications are disabled. See plan 46-06 for rationale.
 */

import { describe, it, expect, vi } from "vitest";
import { mergeDispatchNotificationRecipient } from "../dispatch-notification.js";
import { OpenClawToolInvocationContextStore } from "../tool-invocation-context.js";

describe("Phase 46 / Bug 2C — mergeDispatchNotificationRecipient actor fallback", () => {
  /**
   * Construct a structurally valid OpenClawNotificationRecipient mock.
   * Field set verified against `src/openclaw/tool-invocation-context.ts`
   * (interface `OpenClawNotificationRecipient`, lines 8-17). The factory
   * pattern lets all test cases share one mock shape and lets a future
   * field addition surface as an obvious test-time signal rather than a
   * silent type-erased pass-through.
   */
  function buildStoredRecipient(
    overrides: Partial<{
      kind: "openclaw-session";
      sessionKey: string;
      sessionId: string;
      replyTarget: string;
      channel: string;
      threadId: string;
      actor: string;
      capturedAt: string;
    }> = {},
  ): {
    kind: "openclaw-session";
    sessionKey?: string;
    sessionId?: string;
    replyTarget?: string;
    channel?: string;
    threadId?: string;
    actor?: string;
    capturedAt: string;
  } {
    return {
      kind: "openclaw-session",
      sessionKey: "agent:main:telegram:group:42",
      sessionId: "sess-test-1",
      replyTarget: "42",
      channel: "telegram",
      threadId: "thread-test-1",
      actor: "captured-agent-id",
      capturedAt: "2026-04-24T00:00:00Z",
      ...overrides,
    };
  }

  it("falls back params.actor to captured.actor when params.actor is absent", () => {
    const store = new OpenClawToolInvocationContextStore();
    vi.spyOn(store, "consumeToolCall").mockReturnValue(buildStoredRecipient());

    const result = mergeDispatchNotificationRecipient(
      { title: "t", brief: "b" },
      "tc-1",
      store,
    );
    expect(result.actor).toBe("captured-agent-id");
  });

  it("explicit params.actor wins over captured.actor", () => {
    const store = new OpenClawToolInvocationContextStore();
    vi.spyOn(store, "consumeToolCall").mockReturnValue(buildStoredRecipient());

    const result = mergeDispatchNotificationRecipient(
      { title: "t", brief: "b", actor: "explicit-actor" },
      "tc-2",
      store,
    );
    expect(result.actor).toBe("explicit-actor");
  });

  it("no captured AND no params.actor → no actor injected (params.actor remains undefined)", () => {
    const store = new OpenClawToolInvocationContextStore();
    vi.spyOn(store, "consumeToolCall").mockReturnValue(undefined);

    const result = mergeDispatchNotificationRecipient(
      { title: "t", brief: "b" },
      "tc-3",
      store,
    );
    expect(result.actor).toBeUndefined();
  });

  it("captured.actor is injected even when notifyOnCompletion is false", () => {
    // Phase 46 reorder: consumeToolCall fires BEFORE the notifyOnCompletion=false
    // early-return so actor injection still applies. The early-return path now
    // returns the actor-enriched params, not the raw input.
    const store = new OpenClawToolInvocationContextStore();
    vi.spyOn(store, "consumeToolCall").mockReturnValue(buildStoredRecipient());

    const result = mergeDispatchNotificationRecipient(
      { title: "t", brief: "b", notifyOnCompletion: false },
      "tc-4",
      store,
    );
    expect(result.actor).toBe("captured-agent-id");
    expect(result.notifyOnCompletion).toBe(false);
  });
});
