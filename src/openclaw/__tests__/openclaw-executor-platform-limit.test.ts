import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenClawAdapter } from "../openclaw-executor.js";
import type { OpenClawApi } from "../types.js";

const mockRunEmbeddedPiAgent = vi.fn();
const mockEnsureAgentWorkspace = vi.fn(async (p: { dir: string }) => ({ dir: p.dir }));
const mockExtApi = {
  runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/ws"),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  ensureAgentWorkspace: mockEnsureAgentWorkspace,
  resolveSessionFilePath: vi.fn((id: string) => `/tmp/s/${id}.jsonl`),
};

describe("OpenClawAdapter - Platform Limit Detection", () => {
  let executor: OpenClawAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockApi = { config: { agents: {} } } as unknown as OpenClawApi;
    executor = new OpenClawAdapter(mockApi);
    (executor as any).extensionApi = mockExtApi;
  });

  it("should parse platform limit from setup-stage error", async () => {
    // Fire-and-forget: only setup-stage errors surface in spawnSession return.
    // Mock ensureAgentWorkspace to throw with a platform limit message.
    mockEnsureAgentWorkspace.mockRejectedValueOnce(
      new Error("sessions_spawn has reached max active children for this session (3/2)"),
    );

    const result = await executor.spawnSession({
      taskId: "test-001",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: { agent: "agent:test:main" },
    });

    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(2);
    expect(result.error).toContain("max active children");
  });

  it("should return undefined platformLimit for non-platform-limit errors", async () => {
    // Setup-stage error without platform limit message
    mockEnsureAgentWorkspace.mockRejectedValueOnce(new Error("Agent not found"));

    const result = await executor.spawnSession({
      taskId: "test-002",
      taskPath: "/path/to/task.md",
      agent: "agent:nonexistent:main",
      priority: "medium",
      routing: {},
    });

    expect(result.success).toBe(false);
    expect(result.platformLimit).toBeUndefined();
    expect(result.error).toContain("Agent not found");
  });

  it("should handle different number formats in platform limit", async () => {
    mockEnsureAgentWorkspace.mockRejectedValueOnce(
      new Error("max active children for this session (10/5)"),
    );

    const result = await executor.spawnSession({
      taskId: "test-003",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: {},
    });

    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(5);
  });

  it("should log platform limit from background agent result (fire-and-forget)", async () => {
    // When runEmbeddedPiAgent returns a meta.error with platform limit,
    // the error is logged in the background — spawnSession still returns success.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: {
        durationMs: 100,
        error: {
          kind: "retry_limit",
          message: "sessions_spawn has reached max active children for this session (5/3)",
        },
      },
    });

    const result = await executor.spawnSession({
      taskId: "test-004",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: {},
    });

    // Fire-and-forget: spawn succeeds; error logged in background
    expect(result.success).toBe(true);

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("max active children"),
    ));

    warnSpy.mockRestore();
  });
});
