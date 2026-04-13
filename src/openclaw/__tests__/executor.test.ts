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
const mockRuntimeSubagentRun = vi.fn();
const mockRuntimeSubagentWaitForRun = vi.fn();
const mockRuntimeAgentRunEmbeddedPiAgent = vi.fn();
const mockRuntimeAgentResolveAgentWorkspaceDir = vi.fn(() => "/tmp/runtime-ws");
const mockRuntimeAgentResolveAgentDir = vi.fn(() => "/tmp/runtime-agent");
const mockRuntimeAgentEnsureAgentWorkspace = vi.fn(async () => ({ dir: "/tmp/runtime-ws" }));
const mockRuntimeAgentResolveSessionFilePath = vi.fn((_: unknown, id: string) => `/tmp/runtime-s/${id}.jsonl`);
const mockExtApi = {
  runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/ws"),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  ensureAgentWorkspace: vi.fn(async (p: { dir: string }) => ({ dir: p.dir })),
  resolveSessionFilePath: vi.fn((id: string) => `/tmp/s/${id}.jsonl`),
};

describe("OpenClawAdapter", () => {
  let mockApi: OpenClawApi;
  let executor: OpenClawAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmbeddedPiAgent.mockReset();
    mockRuntimeSubagentRun.mockReset();
    mockRuntimeSubagentWaitForRun.mockReset();
    mockRuntimeAgentRunEmbeddedPiAgent.mockReset();
    mockRuntimeAgentResolveAgentWorkspaceDir.mockReset().mockImplementation(() => "/tmp/runtime-ws");
    mockRuntimeAgentResolveAgentDir.mockReset().mockImplementation(() => "/tmp/runtime-agent");
    mockRuntimeAgentEnsureAgentWorkspace.mockReset().mockImplementation(async () => ({ dir: "/tmp/runtime-ws" }));
    mockRuntimeAgentResolveSessionFilePath.mockReset().mockImplementation((_: unknown, id: string) => `/tmp/runtime-s/${id}.jsonl`);
    mockExtApi.resolveAgentWorkspaceDir.mockReset().mockImplementation(() => "/tmp/ws");
    mockExtApi.resolveAgentDir.mockReset().mockImplementation(() => "/tmp/agent");
    mockExtApi.ensureAgentWorkspace.mockReset().mockImplementation(async (p: { dir: string }) => ({ dir: p.dir }));
    mockExtApi.resolveSessionFilePath.mockReset().mockImplementation((id: string) => `/tmp/s/${id}.jsonl`);
    mockApi = {
      config: { agents: {} },
      runtime: {
        subagent: {
          run: mockRuntimeSubagentRun,
          waitForRun: mockRuntimeSubagentWaitForRun,
        },
        agent: {
          runEmbeddedPiAgent: mockRuntimeAgentRunEmbeddedPiAgent,
          resolveAgentWorkspaceDir: mockRuntimeAgentResolveAgentWorkspaceDir,
          resolveAgentDir: mockRuntimeAgentResolveAgentDir,
          ensureAgentWorkspace: mockRuntimeAgentEnsureAgentWorkspace,
          session: {
            resolveSessionFilePath: mockRuntimeAgentResolveSessionFilePath,
          },
        },
      },
    } as unknown as OpenClawApi;
    executor = new OpenClawAdapter(mockApi);
    (executor as any).extensionApi = mockExtApi;
  });

  it("spawns agent session successfully", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-123",
      childSessionKey: "agent:swe-backend:subagent:child-123",
    });

    const context: TaskContext = {
      taskId: "TASK-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "high",
      routing: { role: "backend-engineer" },
    };

    const result = await executor.spawnSession(context);

    // Fire-and-forget: returns immediately with a generated UUID, not the agent's sessionId
    expect(result.success).toBe(true);
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    await vi.waitFor(() => expect(mockRuntimeSubagentRun).toHaveBeenCalledTimes(1));
    expect(mockRuntimeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(/^agent:swe-backend:subagent:/),
        agentId: "swe-backend",
        message: expect.stringContaining("TASK-001"),
        deliver: false,
      }),
    );
    expect(mockRuntimeAgentRunEmbeddedPiAgent).not.toHaveBeenCalled();
    expect(mockRunEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("handles setup failure gracefully (ensureAgentWorkspace throws)", async () => {
    mockRuntimeSubagentRun.mockRejectedValueOnce(new Error("Agent not found"));

    const context: TaskContext = {
      taskId: "TASK-002",
      taskPath: "/path/to/task.md",
      agent: "nonexistent-agent",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawnSession(context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent not found");
  });

  it("clamps timeout to 300_000ms minimum", async () => {
    // Code applies Math.max(opts.timeoutMs, 300_000) — anything below 300s is clamped
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-timeout-min",
    });

    const context: TaskContext = {
      taskId: "TASK-003",
      taskPath: "/path/to/task.md",
      agent: "swe-qa",
      priority: "low",
      routing: {},
    };

    await executor.spawnSession(context, { timeoutMs: 60_000 });

    await vi.waitFor(() => expect(mockRuntimeSubagentRun).toHaveBeenCalledTimes(1));
    expect(mockRuntimeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("passes through timeout above 300_000ms minimum", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-timeout-max",
    });

    const context: TaskContext = {
      taskId: "TASK-003b",
      taskPath: "/path/to/task.md",
      agent: "swe-qa",
      priority: "low",
      routing: {},
    };

    await executor.spawnSession(context, { timeoutMs: 600_000 });

    await vi.waitFor(() => expect(mockRuntimeSubagentRun).toHaveBeenCalledTimes(1));
    expect(mockRuntimeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
  });

  it("includes routing metadata in prompt", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-routing",
    });

    const context: TaskContext = {
      taskId: "TASK-004",
      taskPath: "/path/to/task.md",
      agent: "swe-frontend",
      priority: "critical",
      routing: { role: "frontend-engineer", team: "swe", tags: ["ui", "react"] },
    };

    await executor.spawnSession(context);

    const params = mockRuntimeSubagentRun.mock.calls[0][0];
    expect(params.message).toContain("frontend-engineer");
  });

  it("handles background API exceptions without affecting spawn result", async () => {
    mockExecLogFns.error.mockClear();
    mockRuntimeSubagentRun.mockResolvedValueOnce({ runId: "run-bg-error" });
    mockRuntimeSubagentWaitForRun.mockRejectedValueOnce(new Error("Network error"));

    const context: TaskContext = {
      taskId: "TASK-005",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawnSession(context);

    // spawnSession returns success — the error happens in background
    expect(result.success).toBe(true);

    // Background logs the error via structured logger
    await vi.waitFor(() => expect(mockExecLogFns.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "TASK-005", runId: "run-bg-error" }),
      expect.stringContaining("subagent waitForRun failed"),
    ));
  });

  it("includes aof_task_complete instruction with taskId", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-complete",
    });

    const context: TaskContext = {
      taskId: "TASK-006",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    const params = mockRuntimeSubagentRun.mock.calls[0][0];
    expect(params.message).toContain("aof_task_complete");
    expect(params.message).toContain('taskId="TASK-006"');
  });

  it("normalizes agent:prefix:suffix to agent name", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-normalize",
    });

    const context: TaskContext = {
      taskId: "TASK-007",
      taskPath: "/path/to/task.md",
      agent: "agent:swe-backend:main",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    expect(mockRuntimeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "swe-backend" }),
    );
  });

  it("handles missing config gracefully", async () => {
    const noConfigApi = {} as unknown as OpenClawApi;
    const exec = new OpenClawAdapter(noConfigApi);
    (exec as any).extensionApi = mockExtApi;

    const result = await exec.spawnSession({
      taskId: "TASK-008",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("config");
  });

  it("falls back to api.runtime.agent.runEmbeddedPiAgent when subagent runtime is unavailable", async () => {
    delete (mockApi.runtime as any).subagent;
    mockRuntimeAgentRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "runtime-agent-123", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-RT-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawnSession(context);

    expect(result.success).toBe(true);
    await vi.waitFor(() => expect(mockRuntimeAgentRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRuntimeAgentRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(/^agent:swe-backend:subagent:/),
        agentId: "swe-backend",
        prompt: expect.stringContaining("TASK-RT-001"),
      }),
    );
    expect(mockRunEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("reports runtime subagent sessions as alive for non-terminal waitForRun statuses", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-status-alive",
      childSessionKey: "agent:swe-backend:subagent:child-alive",
    });
    mockRuntimeSubagentWaitForRun.mockResolvedValue({
      status: "running",
    });

    const context: TaskContext = {
      taskId: "TASK-STATUS-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    const spawn = await executor.spawnSession(context);
    const status = await executor.getSessionStatus(spawn.sessionId!);

    expect(status.alive).toBe(true);
  });

  it("falls back to legacy extensionAPI when runtime helpers are unavailable", async () => {
    delete (mockApi.runtime as any).subagent;
    delete (mockApi.runtime as any).agent;
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "legacy-123", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-LEGACY-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawnSession(context);

    expect(result.success).toBe(true);
    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(/^agent:swe-backend:subagent:/),
        agentId: "swe-backend",
      }),
    );
  });

  it("invokes onRunComplete callback after successful agent run", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-callback",
    });
    mockRuntimeSubagentWaitForRun.mockResolvedValueOnce({
      status: "completed",
    });

    const onRunComplete = vi.fn();

    const context: TaskContext = {
      taskId: "TASK-CB-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context, { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    const outcome: AgentRunOutcome = onRunComplete.mock.calls[0][0];
    expect(outcome.taskId).toBe("TASK-CB-001");
    expect(outcome.success).toBe(true);
    expect(outcome.aborted).toBe(false);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("invokes onRunComplete with error when agent fails", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-callback-error",
    });
    mockRuntimeSubagentWaitForRun.mockRejectedValueOnce(new Error("Agent crashed"));

    const onRunComplete = vi.fn();

    const context: TaskContext = {
      taskId: "TASK-CB-002",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context, { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    const outcome: AgentRunOutcome = onRunComplete.mock.calls[0][0];
    expect(outcome.taskId).toBe("TASK-CB-002");
    expect(outcome.success).toBe(false);
    expect(outcome.error?.kind).toBe("subagent_wait");
    expect(outcome.error?.message).toContain("Agent crashed");
  });

  it("invokes onRunComplete with aborted=true when agent is aborted", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-callback-aborted",
    });
    mockRuntimeSubagentWaitForRun.mockResolvedValueOnce({
      status: "aborted",
    });

    const onRunComplete = vi.fn();

    const context: TaskContext = {
      taskId: "TASK-CB-003",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context, { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    const outcome: AgentRunOutcome = onRunComplete.mock.calls[0][0];
    expect(outcome.success).toBe(false);
    expect(outcome.aborted).toBe(true);
  });

  it("treats non-terminal waitForRun statuses as unsuccessful completion outcomes", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-callback-running",
    });
    mockRuntimeSubagentWaitForRun.mockResolvedValueOnce({
      status: "running",
    });

    const onRunComplete = vi.fn();

    const context: TaskContext = {
      taskId: "TASK-CB-004",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context, { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    const outcome: AgentRunOutcome = onRunComplete.mock.calls[0][0];
    expect(outcome.success).toBe(false);
    expect(outcome.aborted).toBe(false);
    expect(outcome.error?.kind).toBe("subagent");
    expect(outcome.error?.message).toContain("did not reach a terminal status");
  });

  it("passes alsoAllow with AOF tool names to embedded runtime fallback", async () => {
    delete (mockApi.runtime as any).subagent;
    mockRuntimeAgentRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000 },
    });

    const context: TaskContext = {
      taskId: "TASK-ALLOW-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    await vi.waitFor(() => expect(mockRuntimeAgentRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRuntimeAgentRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        alsoAllow: expect.arrayContaining(["aof_task_complete", "aof_task_update"]),
      }),
    );
  });

  it("includes tool verification instruction in subagent message", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-verify",
    });

    const context: TaskContext = {
      taskId: "TASK-VERIFY-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    await vi.waitFor(() => expect(mockRuntimeSubagentRun).toHaveBeenCalledTimes(1));
    const params = mockRuntimeSubagentRun.mock.calls[0][0];
    expect(params.message).toContain("verify that the `aof_task_complete` tool is available");
  });

  it("formatTaskInstruction includes FAILED consequence warning", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-enf-1",
    });

    const context: TaskContext = {
      taskId: "TASK-ENF-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    await vi.waitFor(() => expect(mockRuntimeSubagentRun).toHaveBeenCalledTimes(1));
    const params = mockRuntimeSubagentRun.mock.calls[0][0];
    expect(params.message).toContain("FAILED");
  });

  it("formatTaskInstruction includes retried-by-another-agent language", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-enf-2",
    });

    const context: TaskContext = {
      taskId: "TASK-ENF-002",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    await vi.waitFor(() => expect(mockRuntimeSubagentRun).toHaveBeenCalledTimes(1));
    const params = mockRuntimeSubagentRun.mock.calls[0][0];
    expect(params.message).toContain("retried by another agent");
  });

  it("formatTaskInstruction includes summary-of-actions instruction", async () => {
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-enf-3",
    });

    const context: TaskContext = {
      taskId: "TASK-ENF-003",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    await vi.waitFor(() => expect(mockRuntimeSubagentRun).toHaveBeenCalledTimes(1));
    const params = mockRuntimeSubagentRun.mock.calls[0][0];
    expect(params.message).toContain("summary of actions");
  });

  it("handles onRunComplete callback errors gracefully", async () => {
    mockExecLogFns.error.mockClear();
    mockRuntimeSubagentRun.mockResolvedValueOnce({
      runId: "run-callback-boom",
    });
    mockRuntimeSubagentWaitForRun.mockResolvedValueOnce({
      status: "completed",
    });

    const onRunComplete = vi.fn().mockRejectedValueOnce(new Error("callback boom"));

    const context: TaskContext = {
      taskId: "TASK-CB-ERR",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context, { onRunComplete });

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockExecLogFns.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "TASK-CB-ERR" }),
      expect.stringContaining("onRunComplete callback failed"),
    ));
  });
});
