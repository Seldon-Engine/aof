/**
 * BUG-2026-04-28 (Workstream 3 — dispatch ghosting):
 *
 * Two contributing factors to the recurring "spawn-poller spawn
 * received → no agent run, no failure event, no session file"
 * pattern:
 *
 * 1. AOF passed neither `authProfileId` nor `authProfileIdSource` to
 *    `runEmbeddedPiAgent`. OpenClaw's profile-resolution path then
 *    silently picked an internal default — sometimes one that didn't
 *    exist in the AOF-spawned agent's profile scope, surfacing as
 *    `No credentials found for profile "<provider>:default"`. With
 *    explicit `authProfileId: "<provider>:default"` and
 *    `authProfileIdSource: "auto"`, OpenClaw starts profile resolution
 *    from a known-good preferred profile and falls back through the
 *    profile order if needed (verified against
 *    `~/Projects/openclaw/src/agents/pi-embedded-runner/run.ts`,
 *    `preferredProfileId = params.authProfileId?.trim()` branch).
 *
 * 2. `prepared.setup()` in `runAgentFromSpawnRequest` (and the
 *    in-process `OpenClawAdapter.spawnSession` path) had no timeout.
 *    If `runtimeAgent.ensureAgentWorkspace` or any other
 *    setup-phase IPC helper hung silently, the dispatch ghosted
 *    until the per-task timeout fired (1-4 hours typical). The new
 *    `withSetupTimeout` watchdog wraps both call sites with a 30 s
 *    ceiling; a wedged setup now surfaces as a `setup_error` outcome
 *    that flows through the normal failure-tracker path.
 *
 * Acceptance: dispatch failure modes either succeed end-to-end or
 * surface a classified, retryable error within 30 seconds — no more
 * silent multi-hour ghosts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

import { OpenClawAdapter } from "../executor.js";
import type { OpenClawApi } from "../types.js";
import type { TaskContext } from "../../dispatch/executor.js";

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
    taskId: "TASK-AUTH-001",
    taskPath: "/path/to/task.md",
    agent: "swe-architect",
    priority: "normal",
    routing: {},
    ...overrides,
  };
}

describe("BUG-2026-04-28 step #4 (Workstream 3) — auth profile + setup timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmbeddedPiAgent.mockReset();
    mockResolveAgentWorkspaceDir.mockReset().mockImplementation(() => "/tmp/ws");
    mockResolveAgentDir.mockReset().mockImplementation(() => "/tmp/agent");
    mockEnsureAgentWorkspace.mockReset().mockImplementation(async (p: { dir: string }) => ({ dir: p.dir }));
    mockResolveSessionFilePath.mockReset().mockImplementation((_: unknown, id: string) => `/tmp/s/${id}.jsonl`);
  });

  describe("explicit auth profile passing", () => {
    it("derives authProfileId from the agent's configured provider and pins source to 'auto'", async () => {
      const api = buildApi({
        agents: {
          list: [
            { id: "swe-architect", model: "openai/gpt-5.5" },
          ],
        },
      });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

      const exec = new OpenClawAdapter(api);
      await exec.spawnSession(baseContext({ agent: "swe-architect" }));

      await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
      expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          model: "gpt-5.5",
          authProfileId: "openai:default",
          authProfileIdSource: "auto",
        }),
      );
    });

    it("works for litellm-style providers too", async () => {
      const api = buildApi({
        agents: {
          list: [
            { id: "researcher", model: "litellm/gemini-3.1-pro-preview-customtools" },
          ],
        },
      });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

      const exec = new OpenClawAdapter(api);
      await exec.spawnSession(baseContext({ agent: "researcher" }));

      await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
      expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "litellm",
          authProfileId: "litellm:default",
          authProfileIdSource: "auto",
        }),
      );
    });

    it("omits authProfile fields when no provider can be derived (bare model)", async () => {
      const api = buildApi({
        agents: {
          list: [
            // Single token, no slash — no provider portion to derive.
            { id: "bare-agent", model: "gpt-5.5" },
          ],
        },
      });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

      const exec = new OpenClawAdapter(api);
      await exec.spawnSession(baseContext({ agent: "bare-agent" }));

      await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
      const call = mockRunEmbeddedPiAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.authProfileId).toBeUndefined();
      expect(call.authProfileIdSource).toBeUndefined();
    });

    it("omits authProfile fields when agent has no model configured", async () => {
      const api = buildApi({ agents: { list: [] } });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

      const exec = new OpenClawAdapter(api);
      await exec.spawnSession(baseContext({ agent: "unconfigured-agent" }));

      await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
      const call = mockRunEmbeddedPiAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.authProfileId).toBeUndefined();
      expect(call.authProfileIdSource).toBeUndefined();
    });
  });

  describe("setup-phase timeout", () => {
    it("surfaces a setup-timeout error when ensureAgentWorkspace hangs (>30s)", async () => {
      // Hang ensureAgentWorkspace forever to simulate a wedged
      // OpenClaw runtime helper. Use fake timers so the test takes
      // milliseconds, not 30 seconds.
      mockEnsureAgentWorkspace.mockImplementationOnce(
        () => new Promise<{ dir: string }>(() => {}),
      );

      vi.useFakeTimers();
      try {
        const exec = new OpenClawAdapter(buildApi());
        const promise = exec.spawnSession(baseContext());

        // Advance past the 30s setup timeout.
        await vi.advanceTimersByTimeAsync(30_001);

        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/setup timed out/);
        // The hung agent run was never reached.
        expect(mockRunEmbeddedPiAgent).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not interfere with fast setups", async () => {
      // Normal setup resolves fast; should not trigger the timeout.
      mockEnsureAgentWorkspace.mockResolvedValueOnce({ dir: "/tmp/ws" });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 5 } });

      const exec = new OpenClawAdapter(buildApi());
      const result = await exec.spawnSession(baseContext());

      expect(result.success).toBe(true);
      await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));
    });
  });
});
