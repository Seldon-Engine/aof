import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenClawAdapter } from "../openclaw-executor.js";
import type { OpenClawApi } from "../types.js";

const mockPlatLogFns = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
  error: vi.fn(), fatal: vi.fn(), child: vi.fn(),
};
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: (...args: unknown[]) => mockPlatLogFns.trace(...args),
    debug: (...args: unknown[]) => mockPlatLogFns.debug(...args),
    info: (...args: unknown[]) => mockPlatLogFns.info(...args),
    warn: (...args: unknown[]) => mockPlatLogFns.warn(...args),
    error: (...args: unknown[]) => mockPlatLogFns.error(...args),
    fatal: (...args: unknown[]) => mockPlatLogFns.fatal(...args),
    child: (...args: unknown[]) => mockPlatLogFns.child(...args),
  }),
}));

const mockRunEmbeddedPiAgent = vi.fn();
const mockEnsureAgentWorkspace = vi.fn(async (p: { dir: string }) => ({ dir: p.dir }));

function buildApi(): OpenClawApi {
  return {
    config: { agents: {} },
    runtime: {
      agent: {
        runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/ws"),
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        ensureAgentWorkspace: mockEnsureAgentWorkspace,
        session: { resolveSessionFilePath: vi.fn((_: unknown, id: string) => `/tmp/s/${id}.jsonl`) },
      },
    },
  } as unknown as OpenClawApi;
}

describe("OpenClawAdapter - Platform Limit Detection", () => {
  let executor: OpenClawAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmbeddedPiAgent.mockReset();
    mockEnsureAgentWorkspace.mockReset().mockImplementation(async (p: { dir: string }) => ({ dir: p.dir }));
    executor = new OpenClawAdapter(buildApi());
  });

  it("parses platform limit from setup-stage error (ensureAgentWorkspace throws)", async () => {
    mockEnsureAgentWorkspace.mockRejectedValueOnce(
      new Error("sessions_spawn has reached max active children for this session (3/2)"),
    );

    const result = await executor.spawnSession({
      taskId: "test-001",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: { role: "test" },
    });

    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(2);
    expect(result.error).toContain("max active children");
  });

  it("returns undefined platformLimit for non-platform-limit setup errors", async () => {
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

  it("handles different number formats in the platform-limit message", async () => {
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

  it("logs platform-limit error from the background agent result (fire-and-forget)", async () => {
    mockPlatLogFns.warn.mockClear();
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

    // Fire-and-forget: spawn succeeds; error is logged in background
    expect(result.success).toBe(true);

    await vi.waitFor(() => expect(mockPlatLogFns.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("max active children") }),
      expect.any(String),
    ));
  });
});
