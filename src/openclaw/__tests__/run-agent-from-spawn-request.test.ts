import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

import { runAgentFromSpawnRequest } from "../openclaw-executor.js";
import type { OpenClawApi } from "../types.js";
import type { SpawnRequest } from "../../ipc/schemas.js";

const mockRunEmbeddedPiAgent = vi.fn();
const mockResolveAgentWorkspaceDir = vi.fn(() => "/tmp/ws");
const mockResolveAgentDir = vi.fn(() => "/tmp/agent");
const mockEnsureAgentWorkspace = vi.fn(async (p: { dir: string }) => ({ dir: p.dir }));
const mockResolveSessionFilePath = vi.fn((id: string) => `/tmp/s/${id}.jsonl`);

function buildApi(config: Record<string, unknown> = { agents: {} }): OpenClawApi {
  return {
    config,
    runtime: {
      agent: {
        runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
        resolveAgentWorkspaceDir: mockResolveAgentWorkspaceDir,
        resolveAgentDir: mockResolveAgentDir,
        ensureAgentWorkspace: mockEnsureAgentWorkspace,
        session: { resolveSessionFilePath: mockResolveSessionFilePath },
      },
    },
  } as unknown as OpenClawApi;
}

function spawnRequest(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    id: "spawn-001",
    taskId: "TASK-001",
    taskPath: "/path/to/task.md",
    agent: "swe-backend",
    priority: "normal",
    routing: {},
    callbackDepth: 0,
    ...overrides,
  };
}

describe("runAgentFromSpawnRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmbeddedPiAgent.mockReset();
    mockResolveAgentWorkspaceDir.mockReset().mockImplementation(() => "/tmp/ws");
    mockResolveAgentDir.mockReset().mockImplementation(() => "/tmp/agent");
    mockEnsureAgentWorkspace.mockReset().mockImplementation(async (p: { dir: string }) => ({ dir: p.dir }));
    mockResolveSessionFilePath.mockReset().mockImplementation((id: string) => `/tmp/s/${id}.jsonl`);
  });

  it("invokes runEmbeddedPiAgent with the resolved session/workspace and returns success", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 100 } });

    const result = await runAgentFromSpawnRequest(
      buildApi(),
      spawnRequest({ agent: "swe-backend", priority: "high" }),
    );

    expect(result.success).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBe(100);
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(/^agent:swe-backend:subagent:/),
        agentId: "swe-backend",
        prompt: expect.stringContaining("TASK-001"),
        lane: "aof",
        senderIsOwner: true,
      }),
    );
  });

  it("resolves workspace, agent dir, and session file from runtime.agent helpers", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });
    mockResolveAgentWorkspaceDir.mockReturnValueOnce("/custom/ws");
    mockResolveAgentDir.mockReturnValueOnce("/custom/agent");
    mockEnsureAgentWorkspace.mockResolvedValueOnce({ dir: "/custom/ws-ensured" });
    mockResolveSessionFilePath.mockReturnValueOnce("/custom/sessions/x.jsonl");

    await runAgentFromSpawnRequest(buildApi(), spawnRequest());

    expect(mockEnsureAgentWorkspace).toHaveBeenCalledWith({ dir: "/custom/ws" });
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/custom/ws-ensured",
        agentDir: "/custom/agent",
        sessionFile: "/custom/sessions/x.jsonl",
      }),
    );
  });

  it("returns setup_error when runtime.agent.runEmbeddedPiAgent is missing (pre-2026.2 openclaw)", async () => {
    const bareApi = { config: { agents: {} }, runtime: {} } as unknown as OpenClawApi;

    const result = await runAgentFromSpawnRequest(bareApi, spawnRequest());

    expect(result.success).toBe(false);
    expect(result.error?.kind).toBe("setup_error");
    expect(result.error?.message).toContain("runtime.agent.runEmbeddedPiAgent");
  });

  it("returns setup_error when api.config is missing", async () => {
    const result = await runAgentFromSpawnRequest({} as unknown as OpenClawApi, spawnRequest());

    expect(result.success).toBe(false);
    expect(result.error?.kind).toBe("setup_error");
    expect(result.error?.message).toContain("config");
  });

  it("honors the SpawnRequest timeoutMs", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await runAgentFromSpawnRequest(buildApi(), spawnRequest({ timeoutMs: 60_000 }));

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  it("defaults to 300_000ms when SpawnRequest.timeoutMs is undefined", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await runAgentFromSpawnRequest(buildApi(), spawnRequest());

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("returns an exception outcome when runEmbeddedPiAgent throws", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("boom"));

    const result = await runAgentFromSpawnRequest(buildApi(), spawnRequest({ taskId: "TASK-EXC" }));

    expect(result.success).toBe(false);
    expect(result.error?.kind).toBe("exception");
    expect(result.error?.message).toContain("boom");
  });

  it("propagates aborted=true from the agent meta", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10, aborted: true } });

    const result = await runAgentFromSpawnRequest(buildApi(), spawnRequest());

    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it("propagates structured agent errors", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 10, error: { kind: "model_error", message: "upstream down" } },
    });

    const result = await runAgentFromSpawnRequest(buildApi(), spawnRequest());

    expect(result.success).toBe(false);
    expect(result.error?.kind).toBe("model_error");
    expect(result.error?.message).toContain("upstream down");
  });

  it("normalizes agent:prefix:suffix to agent name", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await runAgentFromSpawnRequest(buildApi(), spawnRequest({ agent: "agent:swe-backend:main" }));

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "swe-backend" }),
    );
  });

  it("includes routing metadata in the prompt", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await runAgentFromSpawnRequest(
      buildApi(),
      spawnRequest({
        agent: "swe-frontend",
        priority: "critical",
        routing: { role: "frontend-engineer", team: "swe", tags: ["ui", "react"] },
      }),
    );

    const params = mockRunEmbeddedPiAgent.mock.calls[0]?.[0] as { prompt: string };
    expect(params.prompt).toContain("frontend-engineer");
  });

  it("includes aof_task_complete instructions with taskId in the prompt", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await runAgentFromSpawnRequest(buildApi(), spawnRequest({ taskId: "TASK-006" }));

    const params = mockRunEmbeddedPiAgent.mock.calls[0]?.[0] as { prompt: string };
    expect(params.prompt).toContain("aof_task_complete");
    expect(params.prompt).toContain('taskId="TASK-006"');
    expect(params.prompt).toContain("FAILED");
  });

  it("forwards thinking as thinkLevel when provided", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await runAgentFromSpawnRequest(buildApi(), spawnRequest({ thinking: "high" }));

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ thinkLevel: "high" }),
    );
  });

  it("uses the configured target agent model instead of OpenClaw embedded defaults", async () => {
    const api = buildApi({
      agents: {
        list: [{ id: "swe-backend", model: "litellm/gemini-3.1-pro-preview-customtools" }],
      },
    });
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await runAgentFromSpawnRequest(api, spawnRequest({ agent: "swe-backend" }));

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "litellm",
        model: "gemini-3.1-pro-preview-customtools",
      }),
    );
  });

  it("regression: succeeds outside any gateway-request scope (no runtime.subagent needed)", async () => {
    // The previous bug: executor preferred api.runtime.subagent which threw
    // "Plugin runtime subagent methods are only available during a gateway
    //  request" when called from the AOF scheduler's background poller.
    const subagentGuard = {
      get run() { throw new Error("should not access runtime.subagent"); },
    };
    const api = {
      config: { agents: {} },
      runtime: {
        agent: {
          runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
          resolveAgentWorkspaceDir: mockResolveAgentWorkspaceDir,
          resolveAgentDir: mockResolveAgentDir,
          ensureAgentWorkspace: mockEnsureAgentWorkspace,
          session: { resolveSessionFilePath: mockResolveSessionFilePath },
        },
        subagent: subagentGuard,
      },
    } as unknown as OpenClawApi;
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 5 } });

    const result = await runAgentFromSpawnRequest(api, spawnRequest());

    expect(result.success).toBe(true);
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1);
  });
});
