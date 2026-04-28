import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenClawAdapter } from "../executor.js";
import type { OpenClawApi } from "../types.js";
import type { TaskContext, AgentRunOutcome } from "../../dispatch/executor.js";

const mockExecLogFns = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
  error: vi.fn(), fatal: vi.fn(), child: vi.fn(),
};
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: (...args: unknown[]) => mockExecLogFns.trace(...args),
    debug: (...args: unknown[]) => mockExecLogFns.debug(...args),
    info: (...args: unknown[]) => mockExecLogFns.info(...args),
    warn: (...args: unknown[]) => mockExecLogFns.warn(...args),
    error: (...args: unknown[]) => mockExecLogFns.error(...args),
    fatal: (...args: unknown[]) => mockExecLogFns.fatal(...args),
    child: (...args: unknown[]) => mockExecLogFns.child(...args),
  }),
}));

const mockRunEmbeddedPiAgent = vi.fn();
const mockResolveAgentWorkspaceDir = vi.fn(() => "/tmp/ws");
const mockResolveAgentDir = vi.fn(() => "/tmp/agent");
const mockEnsureAgentWorkspace = vi.fn(async (p: { dir: string }) => ({ dir: p.dir }));
const mockResolveSessionFilePath = vi.fn((_: unknown, id: string) => `/tmp/s/${id}.jsonl`);

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

function baseContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: "TASK-001",
    taskPath: "/path/to/task.md",
    agent: "swe-backend",
    priority: "normal",
    routing: {},
    ...overrides,
  };
}

describe("OpenClawAdapter", () => {
  let executor: OpenClawAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmbeddedPiAgent.mockReset();
    mockResolveAgentWorkspaceDir.mockReset().mockImplementation(() => "/tmp/ws");
    mockResolveAgentDir.mockReset().mockImplementation(() => "/tmp/agent");
    mockEnsureAgentWorkspace.mockReset().mockImplementation(async (p: { dir: string }) => ({ dir: p.dir }));
    mockResolveSessionFilePath.mockReset().mockImplementation((_: unknown, id: string) => `/tmp/s/${id}.jsonl`);
    executor = new OpenClawAdapter(buildApi());
  });

  it("spawns an agent via runtime.agent.runEmbeddedPiAgent", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 100 } });

    const result = await executor.spawnSession(baseContext({ agent: "swe-backend", priority: "high" }));

    expect(result.success).toBe(true);
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
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

    await executor.spawnSession(baseContext());

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockEnsureAgentWorkspace).toHaveBeenCalledWith({ dir: "/custom/ws" });
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/custom/ws-ensured",
        agentDir: "/custom/agent",
        sessionFile: "/custom/sessions/x.jsonl",
      }),
    );
  });

  it("errors when runtime.agent.runEmbeddedPiAgent is missing (pre-2026.2 openclaw)", async () => {
    const bareApi = { config: { agents: {} }, runtime: {} } as unknown as OpenClawApi;
    const exec = new OpenClawAdapter(bareApi);

    const result = await exec.spawnSession(baseContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("runtime.agent.runEmbeddedPiAgent");
  });

  it("errors when api.config is missing", async () => {
    const exec = new OpenClawAdapter({} as unknown as OpenClawApi);

    const result = await exec.spawnSession(baseContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("config");
  });

  it("honors caller-supplied timeout below 300_000ms (no floor clamp)", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await executor.spawnSession(baseContext(), { timeoutMs: 60_000 });

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  it("passes through large caller-supplied timeout unchanged", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await executor.spawnSession(baseContext(), { timeoutMs: 14_400_000 });

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 14_400_000 }),
    );
  });

  it("defaults to 300_000ms when opts.timeoutMs is undefined", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await executor.spawnSession(baseContext());

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("timeout error message includes taskId and agentId", async () => {
    // Agent promise never resolves; timer fires first.
    mockRunEmbeddedPiAgent.mockImplementationOnce(() => new Promise(() => {}));
    const onRunComplete = vi.fn();

    await executor.spawnSession(
      baseContext({ taskId: "TASK-TIMEOUT-001", agent: "swe-backend" }),
      { timeoutMs: 1, onRunComplete },
    );

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    const outcome: AgentRunOutcome = onRunComplete.mock.calls[0][0];
    expect(outcome.success).toBe(false);
    expect(outcome.error?.message).toContain("TASK-TIMEOUT-001");
    expect(outcome.error?.message).toContain("swe-backend");
    expect(outcome.error?.message).toContain("1ms");
  });

  it("normalizes agent:prefix:suffix to agent name", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await executor.spawnSession(baseContext({ agent: "agent:swe-backend:main" }));

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "swe-backend" }),
    );
  });

  it("includes routing metadata in the prompt", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await executor.spawnSession(baseContext({
      agent: "swe-frontend",
      priority: "critical",
      routing: { role: "frontend-engineer", team: "swe", tags: ["ui", "react"] },
    }));

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("frontend-engineer");
  });

  it("includes aof_task_complete instructions with taskId in the prompt", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await executor.spawnSession(baseContext({ taskId: "TASK-006" }));

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("aof_task_complete");
    expect(params.prompt).toContain('taskId="TASK-006"');
    expect(params.prompt).toContain("verify that the `aof_task_complete` tool is available");
    expect(params.prompt).toContain("FAILED");
    expect(params.prompt).toContain("retried by another agent");
    expect(params.prompt).toContain("summary of actions");
  });

  it("forwards thinking as thinkLevel when provided", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await executor.spawnSession(baseContext({ thinking: "high" }));

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ thinkLevel: "high" }),
    );
  });

  it("uses the configured target agent model instead of OpenClaw embedded defaults", async () => {
    const api = buildApi({
      agents: {
        list: [
          { id: "swe-backend", model: "litellm/gemini-3.1-pro-preview-customtools" },
        ],
      },
    });
    const exec = new OpenClawAdapter(api);
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

    await exec.spawnSession(baseContext({ agent: "swe-backend" }));

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "litellm",
        model: "gemini-3.1-pro-preview-customtools",
      }),
    );
  });

  it("invokes onRunComplete with a success outcome after a clean run", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 1234 } });

    const onRunComplete = vi.fn();
    await executor.spawnSession(baseContext({ taskId: "TASK-CB-001" }), { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    const outcome: AgentRunOutcome = onRunComplete.mock.calls[0][0];
    expect(outcome.taskId).toBe("TASK-CB-001");
    expect(outcome.success).toBe(true);
    expect(outcome.aborted).toBe(false);
    expect(outcome.error).toBeUndefined();
    expect(outcome.durationMs).toBe(1234);
  });

  it("invokes onRunComplete with an error outcome when the agent reports an error", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 10, error: { kind: "model_error", message: "upstream down" } },
    });

    const onRunComplete = vi.fn();
    await executor.spawnSession(baseContext({ taskId: "TASK-CB-002" }), { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    const outcome: AgentRunOutcome = onRunComplete.mock.calls[0][0];
    expect(outcome.success).toBe(false);
    expect(outcome.error?.kind).toBe("model_error");
    expect(outcome.error?.message).toContain("upstream down");
  });

  it("invokes onRunComplete with aborted=true when the agent reports abort", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10, aborted: true } });

    const onRunComplete = vi.fn();
    await executor.spawnSession(baseContext({ taskId: "TASK-CB-003" }), { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    const outcome: AgentRunOutcome = onRunComplete.mock.calls[0][0];
    expect(outcome.success).toBe(false);
    expect(outcome.aborted).toBe(true);
  });

  it("invokes onRunComplete with kind=exception when runEmbeddedPiAgent throws", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("boom"));

    const onRunComplete = vi.fn();
    await executor.spawnSession(baseContext({ taskId: "TASK-CB-004" }), { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    const outcome: AgentRunOutcome = onRunComplete.mock.calls[0][0];
    expect(outcome.success).toBe(false);
    expect(outcome.error?.kind).toBe("exception");
    expect(outcome.error?.message).toContain("boom");
  });

  it("spawnSession returns success even when background run throws", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("upstream timeout"));

    const result = await executor.spawnSession(baseContext({ taskId: "TASK-BG-001" }));

    expect(result.success).toBe(true);
    // The error is captured via onRunComplete / background logging, not surfaced to the caller.
  });

  it("logs but does not throw when onRunComplete itself throws", async () => {
    mockExecLogFns.error.mockClear();
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 1 } });

    const onRunComplete = vi.fn().mockRejectedValueOnce(new Error("callback boom"));

    await executor.spawnSession(baseContext({ taskId: "TASK-CB-ERR" }), { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockExecLogFns.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "TASK-CB-ERR" }),
      expect.stringContaining("onRunComplete callback failed"),
    ));
  });

  it("regression: spawnSession succeeds outside any gateway-request scope (no runtime.subagent needed)", async () => {
    // The previous bug: executor preferred api.runtime.subagent which threw
    // "Plugin runtime subagent methods are only available during a gateway
    //  request" when called from the AOF scheduler's background poller.
    // This test locks in the fix by (a) exposing only runtime.agent and
    // (b) asserting no access is attempted on runtime.subagent.
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

    const exec = new OpenClawAdapter(api);
    const result = await exec.spawnSession(baseContext({ taskId: "TASK-REG-001" }));

    expect(result.success).toBe(true);
    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
  });
});
