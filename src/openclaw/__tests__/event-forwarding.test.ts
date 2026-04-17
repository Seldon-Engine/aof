/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers decision D-07 (as amended by A1 on 2026-04-17): selective event
 * forwarding from the plugin to the daemon. FOUR hooks forward via IPC:
 *   - session_end         → client.postSessionEnd
 *   - agent_end           → client.postAgentEnd
 *   - before_compaction   → client.postBeforeCompaction
 *   - message_received    → client.postMessageReceived   ← A1 RESOLVED
 *
 * A1 RESOLVED: message_received forwards because
 * `src/service/aof-service.ts::handleMessageReceived` (L227-234) routes
 * protocol envelopes to `protocolRouter.route(envelope)`, which mutates
 * daemon-owned session routing state. Confirmed via code inspection during
 * planning (CONTEXT.md D-07 amendment).
 *
 * THREE hooks stay LOCAL (capture only):
 *   - message_sent, before_tool_call, after_tool_call
 *   (and message_received ALSO updates the local invocationContextStore
 *   in addition to forwarding.)
 *
 * RED anchor: imports `DaemonIpcClient` from "../daemon-ipc-client.js" which
 * does not yet exist, plus `ensureDaemonIpcClient`. Wave 3 lands
 * `src/openclaw/daemon-ipc-client.ts` + the selective-forward wiring in
 * `src/openclaw/adapter.ts`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DaemonIpcClient, resetDaemonIpcClient } from "../daemon-ipc-client.js"; // INTENTIONALLY MISSING (pre-Wave 3).
import { stopSpawnPoller } from "../spawn-poller.js";

describe("OpenClaw plugin event forwarding (D-07, A1-amended)", () => {
  afterEach(() => {
    // Tear down module-level singletons so the spawn-poller doesn't leak into
    // subsequent tests (would otherwise spin a mock client in the background).
    stopSpawnPoller();
    resetDaemonIpcClient();
  });
  it("D-07: exports `DaemonIpcClient` and selective-forward mechanism", () => {
    // Merely referencing the import triggers module resolution — RED until
    // Wave 3 lands the client.
    expect(typeof DaemonIpcClient).toBe("function");
  });

  it("D-07: session_end forwards via client.postSessionEnd exactly once", async () => {
    const client = {
      postSessionEnd: vi.fn(async () => undefined),
      postAgentEnd: vi.fn(async () => undefined),
      postBeforeCompaction: vi.fn(async () => undefined),
      postMessageReceived: vi.fn(async () => undefined),
    };
    const events: Record<string, (event: unknown, ctx?: unknown) => void> = {};
    await loadEventForwardingWiring({ client, events });

    forwardEvents_invoke(events, "session_end", { sessionId: "s1" }, { sessionId: "s1", agentId: "a1" });

    expect(client.postSessionEnd).toHaveBeenCalledTimes(1);
    expect(client.postAgentEnd).not.toHaveBeenCalled();
    expect(client.postBeforeCompaction).not.toHaveBeenCalled();
    expect(client.postMessageReceived).not.toHaveBeenCalled();
  });

  it("D-07: agent_end forwards via client.postAgentEnd exactly once", async () => {
    const client = {
      postSessionEnd: vi.fn(async () => undefined),
      postAgentEnd: vi.fn(async () => undefined),
      postBeforeCompaction: vi.fn(async () => undefined),
      postMessageReceived: vi.fn(async () => undefined),
    };
    const events: Record<string, (event: unknown, ctx?: unknown) => void> = {};
    await loadEventForwardingWiring({ client, events });

    forwardEvents_invoke(events, "agent_end", { agent: "swe-backend" });

    expect(client.postAgentEnd).toHaveBeenCalledTimes(1);
    expect(client.postSessionEnd).not.toHaveBeenCalled();
  });

  it("D-07: before_compaction forwards via client.postBeforeCompaction and clears local store", async () => {
    const client = {
      postSessionEnd: vi.fn(async () => undefined),
      postAgentEnd: vi.fn(async () => undefined),
      postBeforeCompaction: vi.fn(async () => undefined),
      postMessageReceived: vi.fn(async () => undefined),
    };
    const events: Record<string, (event: unknown, ctx?: unknown) => void> = {};
    const { captureCalls } = await loadEventForwardingWiring({ client, events }, { captureClearCalls: true });

    forwardEvents_invoke(events, "before_compaction", {});

    expect(client.postBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(captureCalls.clearAll).toBeGreaterThanOrEqual(1);
  });

  it("D-07 (A1 RESOLVED): message_received forwards via client.postMessageReceived AND captures route locally", async () => {
    const client = {
      postSessionEnd: vi.fn(async () => undefined),
      postAgentEnd: vi.fn(async () => undefined),
      postBeforeCompaction: vi.fn(async () => undefined),
      postMessageReceived: vi.fn(async () => undefined),
    };
    const events: Record<string, (event: unknown, ctx?: unknown) => void> = {};
    const { captureCalls } = await loadEventForwardingWiring({ client, events }, { captureClearCalls: true });

    forwardEvents_invoke(events, "message_received", { from: "user", content: "hi" }, {
      sessionKey: "agent:main:telegram:group:42",
    });

    // A1 RESOLVED: fourth forwarded route (handleMessageReceived routes envelopes
    // through protocolRouter.route() → mutates daemon-owned state).
    expect(client.postMessageReceived).toHaveBeenCalledTimes(1);
    // Local side-effect preserved: route capture in invocationContextStore.
    expect(captureCalls.captureMessageRoute).toBeGreaterThanOrEqual(1);
  });

  it("D-07: message_sent does NOT forward (capture-only)", async () => {
    const client = {
      postSessionEnd: vi.fn(async () => undefined),
      postAgentEnd: vi.fn(async () => undefined),
      postBeforeCompaction: vi.fn(async () => undefined),
      postMessageReceived: vi.fn(async () => undefined),
    };
    const events: Record<string, (event: unknown, ctx?: unknown) => void> = {};
    const { captureCalls } = await loadEventForwardingWiring({ client, events }, { captureClearCalls: true });

    forwardEvents_invoke(events, "message_sent", {});

    expect(client.postSessionEnd).not.toHaveBeenCalled();
    expect(client.postAgentEnd).not.toHaveBeenCalled();
    expect(client.postBeforeCompaction).not.toHaveBeenCalled();
    expect(client.postMessageReceived).not.toHaveBeenCalled();
    // Local capture side-effect still invoked.
    expect(captureCalls.captureMessageRoute).toBeGreaterThanOrEqual(1);
  });

  it("D-07: before_tool_call does NOT forward (capture-only)", async () => {
    const client = {
      postSessionEnd: vi.fn(async () => undefined),
      postAgentEnd: vi.fn(async () => undefined),
      postBeforeCompaction: vi.fn(async () => undefined),
      postMessageReceived: vi.fn(async () => undefined),
    };
    const events: Record<string, (event: unknown, ctx?: unknown) => void> = {};
    await loadEventForwardingWiring({ client, events });

    forwardEvents_invoke(events, "before_tool_call", { toolName: "aof_dispatch", toolCallId: "tc-1" });

    expect(client.postSessionEnd).not.toHaveBeenCalled();
    expect(client.postAgentEnd).not.toHaveBeenCalled();
    expect(client.postBeforeCompaction).not.toHaveBeenCalled();
    expect(client.postMessageReceived).not.toHaveBeenCalled();
  });

  it("D-07: after_tool_call does NOT forward (capture-only)", async () => {
    const client = {
      postSessionEnd: vi.fn(async () => undefined),
      postAgentEnd: vi.fn(async () => undefined),
      postBeforeCompaction: vi.fn(async () => undefined),
      postMessageReceived: vi.fn(async () => undefined),
    };
    const events: Record<string, (event: unknown, ctx?: unknown) => void> = {};
    await loadEventForwardingWiring({ client, events });

    forwardEvents_invoke(events, "after_tool_call", { toolName: "aof_dispatch", toolCallId: "tc-1" });

    expect(client.postSessionEnd).not.toHaveBeenCalled();
    expect(client.postAgentEnd).not.toHaveBeenCalled();
    expect(client.postBeforeCompaction).not.toHaveBeenCalled();
    expect(client.postMessageReceived).not.toHaveBeenCalled();
  });

  it("D-07: exactly FOUR forwarding hooks defined (A1-amended count — fails if spec drifts)", async () => {
    const client = {
      postSessionEnd: vi.fn(async () => undefined),
      postAgentEnd: vi.fn(async () => undefined),
      postBeforeCompaction: vi.fn(async () => undefined),
      postMessageReceived: vi.fn(async () => undefined),
    };
    const events: Record<string, (event: unknown, ctx?: unknown) => void> = {};
    await loadEventForwardingWiring({ client, events });

    // Fire all 7 plugin hooks; assert the 4 canonical forwarders each received
    // exactly one call. If Wave 3 implements only 3 forwarders (pre-A1 spec),
    // this test fails loudly on postMessageReceived.
    forwardEvents_invoke(events, "session_end", {});
    forwardEvents_invoke(events, "agent_end", {});
    forwardEvents_invoke(events, "before_compaction", {});
    forwardEvents_invoke(events, "message_received", {}, { sessionKey: "k" });
    forwardEvents_invoke(events, "message_sent", {});
    forwardEvents_invoke(events, "before_tool_call", {});
    forwardEvents_invoke(events, "after_tool_call", {});

    expect(client.postSessionEnd).toHaveBeenCalledTimes(1);
    expect(client.postAgentEnd).toHaveBeenCalledTimes(1);
    expect(client.postBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(client.postMessageReceived).toHaveBeenCalledTimes(1); // A1 RESOLVED
  });
});

// ---------------------------------------------------------------------------
// Helpers — deliberately post-`describe` so the module-level `import` (which
// imports `DaemonIpcClient` from the missing module) is what triggers the RED
// state. These helpers are invoked by each test after Wave 3 lands the real
// wiring.
// ---------------------------------------------------------------------------

interface ClientMock {
  postSessionEnd: ReturnType<typeof vi.fn>;
  postAgentEnd: ReturnType<typeof vi.fn>;
  postBeforeCompaction: ReturnType<typeof vi.fn>;
  postMessageReceived: ReturnType<typeof vi.fn>;
}

/**
 * Register the event-forwarding wiring that Wave 3 lands inside
 * `registerAofPlugin`. Returned `captureCalls` counts local side-effects.
 *
 * NOTE: Wave 3 implementation will expose either a standalone helper
 * (`attachEventForwarding(api, client, store)`) or inline the wiring directly
 * in `registerAofPlugin`. This test-side helper reaches for either shape by
 * importing `../adapter.js` + letting the adapter's `api.on(...)` mount into
 * the supplied `events` record. The test fails fast here if Wave 3 keeps the
 * pre-43 single-path wiring.
 */
async function loadEventForwardingWiring(
  args: {
    client: ClientMock;
    events: Record<string, (event: unknown, ctx?: unknown) => void>;
  },
  opts: { captureClearCalls?: boolean } = {},
): Promise<{ captureCalls: Record<string, number> }> {
  // Reach for the Wave 3 entry point. `registerAofPlugin` post-43 accepts a
  // `daemonIpcClient` opt to inject the mock. If that opt is absent (Wave 3
  // not landed), this throws and the RED state is even more explicit.
  const { registerAofPlugin } = await import("../adapter.js");

  const captureCalls: Record<string, number> = {
    captureMessageRoute: 0,
    captureToolCall: 0,
    clearToolCall: 0,
    clearSessionRoute: 0,
    clearAll: 0,
  };

  const api = {
    registerService: () => {},
    registerTool: () => {},
    registerHttpRoute: () => {},
    on: (event: string, handler: (event: unknown, ctx?: unknown) => void) => {
      args.events[event] = handler;
    },
  };

  // Wave 3 signature (provisional): registerAofPlugin accepts an optional
  // `daemonIpcClient` + optional `invocationContextStore` to receive mocks.
  // Augment the client with a never-resolving `waitForSpawn` + no-op extras so
  // the spawn-poller loop parks on await without spamming logs (afterEach's
  // `stopSpawnPoller()` flips the module gate so the parked loop exits).
  const fullClient = {
    ...args.client,
    waitForSpawn: () => new Promise(() => {}),
    postSpawnResult: async () => undefined,
    selfCheck: async () => true,
    socketPath: "/tmp/fake.sock",
  };

  (registerAofPlugin as unknown as (api: unknown, opts: unknown) => unknown)(api, {
    dataDir: "/tmp/aof",
    daemonIpcClient: fullClient,
    invocationContextStore: opts.captureClearCalls
      ? {
          captureMessageRoute: () => (captureCalls.captureMessageRoute = (captureCalls.captureMessageRoute ?? 0) + 1),
          captureToolCall: () => (captureCalls.captureToolCall = (captureCalls.captureToolCall ?? 0) + 1),
          clearToolCall: () => (captureCalls.clearToolCall = (captureCalls.clearToolCall ?? 0) + 1),
          clearSessionRoute: () => (captureCalls.clearSessionRoute = (captureCalls.clearSessionRoute ?? 0) + 1),
          clearAll: () => (captureCalls.clearAll = (captureCalls.clearAll ?? 0) + 1),
        }
      : undefined,
  });

  return { captureCalls };
}

function forwardEvents_invoke(
  events: Record<string, (event: unknown, ctx?: unknown) => void>,
  name: string,
  event: unknown,
  ctx?: unknown,
): void {
  events[name]?.(event, ctx);
}
