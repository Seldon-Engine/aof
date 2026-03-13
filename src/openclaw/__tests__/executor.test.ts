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
    mockApi = { config: { agents: {} } } as unknown as OpenClawApi;
    executor = new OpenClawAdapter(mockApi);
    (executor as any).extensionApi = mockExtApi;
  });

  it("spawns agent session successfully", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "session-12345", provider: "a", model: "m" } },
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

    // Wait for background agent call to resolve
    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "swe-backend",
        prompt: expect.stringContaining("TASK-001"),
      }),
    );
  });

  it("handles setup failure gracefully (ensureAgentWorkspace throws)", async () => {
    // Fire-and-forget: errors from runEmbeddedPiAgent happen in background.
    // Only setup-stage errors (before the agent is launched) surface in the return value.
    // Mock a setup-stage error: ensureAgentWorkspace throwing.
    mockExtApi.ensureAgentWorkspace.mockRejectedValueOnce(new Error("Agent not found"));

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
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-t", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-003",
      taskPath: "/path/to/task.md",
      agent: "swe-qa",
      priority: "low",
      routing: {},
    };

    await executor.spawnSession(context, { timeoutMs: 60_000 });

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("passes through timeout above 300_000ms minimum", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-t2", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-003b",
      taskPath: "/path/to/task.md",
      agent: "swe-qa",
      priority: "low",
      routing: {},
    };

    await executor.spawnSession(context, { timeoutMs: 600_000 });

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
  });

  it("includes routing metadata in prompt", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-r", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-004",
      taskPath: "/path/to/task.md",
      agent: "swe-frontend",
      priority: "critical",
      routing: { role: "frontend-engineer", team: "swe", tags: ["ui", "react"] },
    };

    await executor.spawnSession(context);

    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("frontend-engineer");
  });

  it("handles background API exceptions without affecting spawn result", async () => {
    // Fire-and-forget: thrown errors from runEmbeddedPiAgent are caught in
    // runAgentBackground and logged — they don't surface in spawnSession return.
    mockExecLogFns.error.mockClear();
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("Network error"));

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
      expect.objectContaining({ taskId: "TASK-005" }),
      expect.stringContaining("background agent run failed"),
    ));
  });

  it("includes aof_task_complete instruction with taskId", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-c", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-006",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("aof_task_complete");
    expect(params.prompt).toContain('taskId="TASK-006"');
  });

  it("normalizes agent:prefix:suffix to agent name", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-n", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-007",
      taskPath: "/path/to/task.md",
      agent: "agent:swe-backend:main",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
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

  it("invokes onRunComplete callback after successful agent run", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 2000, agentMeta: { sessionId: "s-cb", provider: "a", model: "m" } },
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
    expect(outcome.durationMs).toBe(2000);
  });

  it("invokes onRunComplete with error when agent fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("Agent crashed"));

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
    expect(outcome.error?.kind).toBe("exception");
    expect(outcome.error?.message).toContain("Agent crashed");

    errorSpy.mockRestore();
  });

  it("invokes onRunComplete with aborted=true when agent is aborted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 500, aborted: true },
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

    warnSpy.mockRestore();
  });

  it("passes alsoAllow with AOF tool names to runEmbeddedPiAgent", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
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

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        alsoAllow: expect.arrayContaining(["aof_task_complete", "aof_task_update"]),
      }),
    );
  });

  it("includes tool verification instruction in prompt", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000 },
    });

    const context: TaskContext = {
      taskId: "TASK-VERIFY-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("verify that the `aof_task_complete` tool is available");
  });

  it("formatTaskInstruction includes FAILED consequence warning", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-enf1", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-ENF-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("FAILED");
  });

  it("formatTaskInstruction includes retried-by-another-agent language", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-enf2", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-ENF-002",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("retried by another agent");
  });

  it("formatTaskInstruction includes summary-of-actions instruction", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-enf3", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-ENF-003",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("summary of actions");
  });

  it("handles onRunComplete callback errors gracefully", async () => {
    mockExecLogFns.error.mockClear();
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000 },
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
