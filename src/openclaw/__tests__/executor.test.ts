import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenClawAdapter } from "../executor.js";
import type { OpenClawApi } from "../types.js";
import type { TaskContext } from "../../dispatch/executor.js";

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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

    // Background logs the error
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Network error"),
    ));

    errorSpy.mockRestore();
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
});
