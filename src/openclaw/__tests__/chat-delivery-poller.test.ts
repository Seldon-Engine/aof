/**
 * Unit tests for the pure helpers behind the wake-up injection path in
 * `chat-delivery-poller.ts`. The full async dispatch loop is covered by the
 * live recovery-replay E2E observed during development; these tests cover
 * the logic that's worth pinning at the unit level: sessionKey parsing,
 * ephemeral-session redirect, and per-agent heartbeat detection.
 */
import { describe, it, expect, vi } from "vitest";
import {
  parseAgentIdFromSessionKey,
  redirectEphemeralSessionKey,
  agentHasHeartbeat,
} from "../chat-delivery-poller.js";
import type { OpenClawApi } from "../types.js";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

describe("parseAgentIdFromSessionKey", () => {
  it("extracts agentId from a 3-part main session key", () => {
    expect(parseAgentIdFromSessionKey("agent:main:main")).toBe("main");
    expect(parseAgentIdFromSessionKey("agent:researcher:main")).toBe("researcher");
  });

  it("extracts agentId from a 5+ part Telegram session key", () => {
    expect(
      parseAgentIdFromSessionKey("agent:main:telegram:group:-1003844680528:topic:1"),
    ).toBe("main");
  });

  it("extracts agentId from cron and subagent shapes", () => {
    expect(
      parseAgentIdFromSessionKey("agent:researcher:cron:55fd4f34-9ede-4c30-90d2-4caf96e3c127"),
    ).toBe("researcher");
    expect(
      parseAgentIdFromSessionKey("agent:swe-po:subagent:ed11e291-a0c8-4be1-b43e-c6f80aac8444"),
    ).toBe("swe-po");
  });

  it("returns undefined for shapes that don't start with `agent:`", () => {
    expect(parseAgentIdFromSessionKey("global")).toBeUndefined();
    expect(parseAgentIdFromSessionKey("session:abc")).toBeUndefined();
    expect(parseAgentIdFromSessionKey("")).toBeUndefined();
  });

  it("returns undefined when agentId segment is empty", () => {
    expect(parseAgentIdFromSessionKey("agent::main")).toBeUndefined();
    expect(parseAgentIdFromSessionKey("agent:")).toBeUndefined();
  });
});

describe("redirectEphemeralSessionKey", () => {
  it("redirects cron sessionKeys to the agent's main session", () => {
    expect(
      redirectEphemeralSessionKey(
        "agent:researcher:cron:55fd4f34-9ede-4c30-90d2-4caf96e3c127",
        "main",
      ),
    ).toBe("agent:researcher:main");
  });

  it("redirects subagent sessionKeys to the agent's main session", () => {
    expect(
      redirectEphemeralSessionKey(
        "agent:swe-po:subagent:ed11e291-a0c8-4be1-b43e-c6f80aac8444",
        "main",
      ),
    ).toBe("agent:swe-po:main");
  });

  it("honors a custom mainKey when redirecting", () => {
    expect(
      redirectEphemeralSessionKey("agent:researcher:cron:abc", "primary"),
    ).toBe("agent:researcher:primary");
  });

  it("leaves Telegram/Matrix/WhatsApp session keys unchanged", () => {
    const tg = "agent:main:telegram:group:-1003844680528:topic:1";
    const matrix = "agent:main:matrix:room:!abc:topic:0";
    const wa = "agent:main:whatsapp:direct:+15551234567";
    expect(redirectEphemeralSessionKey(tg, "main")).toBe(tg);
    expect(redirectEphemeralSessionKey(matrix, "main")).toBe(matrix);
    expect(redirectEphemeralSessionKey(wa, "main")).toBe(wa);
  });

  it("leaves the agent's main session key unchanged", () => {
    expect(redirectEphemeralSessionKey("agent:main:main", "main")).toBe("agent:main:main");
  });

  it("leaves malformed session keys unchanged (returns as-is)", () => {
    expect(redirectEphemeralSessionKey("not-an-agent-key", "main")).toBe("not-an-agent-key");
    expect(redirectEphemeralSessionKey("agent:", "main")).toBe("agent:");
    expect(redirectEphemeralSessionKey("", "main")).toBe("");
  });
});

describe("agentHasHeartbeat", () => {
  function apiWith(cfg: unknown): OpenClawApi {
    return {
      registerService: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
      runtime: {
        config: { loadConfig: () => cfg } as unknown as Record<string, never>,
      },
    } as unknown as OpenClawApi;
  }

  it("returns true when the agent has its own heartbeat.every set", () => {
    const api = apiWith({
      agents: {
        list: [
          { id: "main", heartbeat: { every: "15m" } },
          { id: "researcher", heartbeat: {} },
        ],
      },
    });
    expect(agentHasHeartbeat(api, "main")).toBe(true);
  });

  it("returns false when the agent has heartbeat: {} (no every)", () => {
    const api = apiWith({
      agents: {
        list: [{ id: "researcher", heartbeat: {} }],
      },
    });
    expect(agentHasHeartbeat(api, "researcher")).toBe(false);
  });

  it("falls back to defaults.heartbeat.every when per-agent every is absent", () => {
    const api = apiWith({
      agents: {
        list: [{ id: "researcher", heartbeat: {} }],
        defaults: { heartbeat: { every: "1h" } },
      },
    });
    expect(agentHasHeartbeat(api, "researcher")).toBe(true);
  });

  it("returns false when neither per-agent nor defaults has every", () => {
    const api = apiWith({
      agents: {
        list: [{ id: "researcher", heartbeat: {} }],
        defaults: { heartbeat: { model: "anthropic-api/claude-sonnet-4-6" } },
      },
    });
    expect(agentHasHeartbeat(api, "researcher")).toBe(false);
  });

  it("returns false for unknown agentId with no defaults", () => {
    const api = apiWith({ agents: { list: [{ id: "main", heartbeat: { every: "15m" } }] } });
    expect(agentHasHeartbeat(api, "ghost")).toBe(false);
  });

  it("returns true for unknown agentId when defaults.heartbeat.every is set", () => {
    const api = apiWith({
      agents: {
        list: [],
        defaults: { heartbeat: { every: "30m" } },
      },
    });
    expect(agentHasHeartbeat(api, "ghost")).toBe(true);
  });

  it("returns false when cfg shape is missing or malformed", () => {
    expect(agentHasHeartbeat(apiWith(undefined), "main")).toBe(false);
    expect(agentHasHeartbeat(apiWith({}), "main")).toBe(false);
    expect(agentHasHeartbeat(apiWith({ agents: null }), "main")).toBe(false);
    expect(agentHasHeartbeat(apiWith({ agents: { list: "not-an-array" } }), "main")).toBe(false);
  });

  it("returns false when runtime.config.loadConfig is missing", () => {
    const api = {
      registerService: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
      runtime: {},
    } as unknown as OpenClawApi;
    expect(agentHasHeartbeat(api, "main")).toBe(false);
  });

  it("treats empty-string every as no-heartbeat", () => {
    const api = apiWith({ agents: { list: [{ id: "main", heartbeat: { every: "" } }] } });
    expect(agentHasHeartbeat(api, "main")).toBe(false);
    const api2 = apiWith({ agents: { list: [{ id: "main", heartbeat: { every: "   " } }] } });
    expect(agentHasHeartbeat(api2, "main")).toBe(false);
  });
});
