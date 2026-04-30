/**
 * Regression: dispatch ghosting via two contributing factors.
 *
 * 1. AOF passed neither `authProfileId` nor `authProfileIdSource` to
 *    `runEmbeddedPiAgent`, so OpenClaw silently picked an internal default —
 *    sometimes one outside the spawned agent's profile scope, surfacing as
 *    `No credentials found for profile "<provider>:default"`. Fix: pass the
 *    derived `<provider>:default` with source `"auto"` so OpenClaw starts
 *    from a known-good preferred profile and falls back through the order.
 *
 * 2. `prepared.setup()` had no timeout. A wedged `ensureAgentWorkspace` (or
 *    any setup-phase IPC helper) silently ghosted dispatches until the
 *    per-task timeout fired (1-4h). Fix: `withSetupTimeout` caps setup at
 *    30s and surfaces a `setup_error` outcome that flows through the normal
 *    failure-tracker path.
 */

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
    taskId: "TASK-AUTH-001",
    taskPath: "/path/to/task.md",
    agent: "swe-architect",
    priority: "normal",
    routing: {},
    callbackDepth: 0,
    ...overrides,
  };
}

describe("BUG-2026-04-28 — auth profile + setup timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmbeddedPiAgent.mockReset();
    mockResolveAgentWorkspaceDir.mockReset().mockImplementation(() => "/tmp/ws");
    mockResolveAgentDir.mockReset().mockImplementation(() => "/tmp/agent");
    mockEnsureAgentWorkspace.mockReset().mockImplementation(async (p: { dir: string }) => ({ dir: p.dir }));
    mockResolveSessionFilePath.mockReset().mockImplementation((id: string) => `/tmp/s/${id}.jsonl`);
  });

  describe("explicit auth profile passing", () => {
    it("derives authProfileId from the agent's configured provider and pins source to 'auto'", async () => {
      const api = buildApi({
        agents: { list: [{ id: "swe-architect", model: "openai/gpt-5.5" }] },
      });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

      await runAgentFromSpawnRequest(api, spawnRequest({ agent: "swe-architect" }));

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
        agents: { list: [{ id: "researcher", model: "litellm/gemini-3.1-pro-preview-customtools" }] },
      });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

      await runAgentFromSpawnRequest(api, spawnRequest({ agent: "researcher" }));

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
        agents: { list: [{ id: "bare-agent", model: "gpt-5.5" }] },
      });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

      await runAgentFromSpawnRequest(api, spawnRequest({ agent: "bare-agent" }));

      const call = mockRunEmbeddedPiAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.authProfileId).toBeUndefined();
      expect(call.authProfileIdSource).toBeUndefined();
    });

    it("omits authProfile fields when agent has no model configured", async () => {
      const api = buildApi({ agents: { list: [] } });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 10 } });

      await runAgentFromSpawnRequest(api, spawnRequest({ agent: "unconfigured-agent" }));

      const call = mockRunEmbeddedPiAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.authProfileId).toBeUndefined();
      expect(call.authProfileIdSource).toBeUndefined();
    });
  });

  describe("setup-phase timeout", () => {
    it("surfaces a setup-timeout error when ensureAgentWorkspace hangs (>30s)", async () => {
      mockEnsureAgentWorkspace.mockImplementationOnce(
        () => new Promise<{ dir: string }>(() => {}),
      );

      vi.useFakeTimers();
      try {
        const promise = runAgentFromSpawnRequest(buildApi(), spawnRequest());

        await vi.advanceTimersByTimeAsync(30_001);

        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.error?.kind).toBe("setup_error");
        expect(result.error?.message).toMatch(/setup timed out/);
        expect(mockRunEmbeddedPiAgent).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not interfere with fast setups", async () => {
      mockEnsureAgentWorkspace.mockResolvedValueOnce({ dir: "/tmp/ws" });
      mockRunEmbeddedPiAgent.mockResolvedValueOnce({ meta: { durationMs: 5 } });

      const result = await runAgentFromSpawnRequest(buildApi(), spawnRequest());

      expect(result.success).toBe(true);
      expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    });
  });
});
