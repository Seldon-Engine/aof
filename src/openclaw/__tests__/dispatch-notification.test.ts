/**
 * Unit tests for mergeDispatchNotificationRecipient — the plugin-local
 * pre-IPC transform that promotes a captured OpenClaw route into a
 * core-agnostic `notifyOnCompletion` SubscriptionDelivery payload.
 *
 * Two groups:
 *   1. Baseline contract (short-circuit, explicit-overrides-captured, undefined-stripping).
 *      These MUST pass today and stay green through Phase 44 implementation.
 *   2. Phase 44 identity enrichment (`dispatcherAgentId`, `capturedAt`, `pluginId`).
 *      These are RED until Plan 03 lands the enrichment in mergeDispatchNotificationRecipient.
 *
 * Pure unit tests of a pure function — no framework mocks, no fixtures. Mirrors
 * the convention in ../../openclaw/__tests__/tool-invocation-context.test.ts.
 */

import { describe, expect, it } from "vitest";
import { mergeDispatchNotificationRecipient } from "../dispatch-notification.js";
import { OpenClawToolInvocationContextStore } from "../tool-invocation-context.js";

describe("mergeDispatchNotificationRecipient — Phase 44 identity enrichment", () => {
  it("enriches delivery with dispatcherAgentId, capturedAt, pluginId from captured route", () => {
    const store = new OpenClawToolInvocationContextStore();
    store.captureToolCall({
      name: "aof_dispatch",
      id: "tc-1",
      sessionKey: "agent:main:telegram:group:42",
      agentId: "main",
      replyTarget: "42",
      channel: "telegram",
    });
    const result = mergeDispatchNotificationRecipient({}, "tc-1", store) as {
      notifyOnCompletion?: Record<string, unknown>;
    };
    expect(result.notifyOnCompletion).toMatchObject({
      kind: "openclaw-chat",
      sessionKey: "agent:main:telegram:group:42",
      dispatcherAgentId: "main",
      pluginId: "openclaw",
    });
    expect(typeof result.notifyOnCompletion?.capturedAt).toBe("string");
    expect(result.notifyOnCompletion?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("omits dispatcherAgentId when captured route has no agentId (undefined-stripping preserved)", () => {
    const store = new OpenClawToolInvocationContextStore();
    store.captureToolCall({
      name: "aof_dispatch",
      id: "tc-2",
      sessionKey: "agent:anon:telegram:group:99",
      // no agentId
    });
    const result = mergeDispatchNotificationRecipient({}, "tc-2", store) as {
      notifyOnCompletion?: Record<string, unknown>;
    };
    expect(result.notifyOnCompletion).toBeDefined();
    expect("dispatcherAgentId" in (result.notifyOnCompletion ?? {})).toBe(false);
  });

  it("explicit notifyOnCompletion object overrides captured enrichment (precedence preserved)", () => {
    const store = new OpenClawToolInvocationContextStore();
    store.captureToolCall({
      name: "aof_dispatch",
      id: "tc-3",
      sessionKey: "agent:main:telegram:group:42",
      agentId: "main",
    });
    const params = {
      notifyOnCompletion: {
        kind: "openclaw-chat",
        sessionKey: "agent:explicit:matrix:room:x",
        dispatcherAgentId: "explicit-agent",
      },
    };
    const result = mergeDispatchNotificationRecipient(params, "tc-3", store) as {
      notifyOnCompletion?: Record<string, unknown>;
    };
    expect(result.notifyOnCompletion?.sessionKey).toBe("agent:explicit:matrix:room:x");
    expect(result.notifyOnCompletion?.dispatcherAgentId).toBe("explicit-agent");
    // Caller did not set pluginId — merge should NOT inject it on top of an explicit object.
    expect("pluginId" in (result.notifyOnCompletion ?? {})).toBe(false);
  });

  it("returns params unchanged when notifyOnCompletion is false (short-circuit preserved)", () => {
    const store = new OpenClawToolInvocationContextStore();
    const params = { someArg: 1, notifyOnCompletion: false as const };
    expect(mergeDispatchNotificationRecipient(params, "tc-4", store)).toBe(params);
  });
});
