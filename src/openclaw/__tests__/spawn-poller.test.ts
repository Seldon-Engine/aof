/**
 * Spawn-poller unit tests (43-06 Task 2).
 *
 * Covers the module-level long-poll loop that drains `GET /v1/spawns/wait`
 * from the daemon and dispatches each received `SpawnRequest` to
 * `runAgentFromSpawnRequest`.
 *
 * Key invariants:
 *   - Pitfall 3: `startSpawnPollerOnce` is idempotent — calling it twice on
 *     the same module instance must NOT spin up a second loop.
 *   - 200 SpawnRequest → `runAgentFromSpawnRequest` invoked; result posted
 *     via `client.postSpawnResult`.
 *   - 204 keepalive → loop reconnects immediately (no handler call).
 *   - Socket errors → bounded exponential backoff (1s → 2s → 4s …, cap 30s).
 *   - Handler throw → the spawn-poster posts a synthetic
 *     `{ success: false, error: { kind: "exception" } }` so the daemon lease
 *     can time out cleanly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SpawnRequest, SpawnResultPost } from "../../ipc/schemas.js";

// Mock runAgentFromSpawnRequest from openclaw-executor so we can observe calls
// without touching the real runEmbeddedPiAgent path.
const mockRunAgentFromSpawnRequest = vi.fn<
  (api: unknown, sr: SpawnRequest) => Promise<SpawnResultPost>
>();
vi.mock("../openclaw-executor.js", async (importActual) => {
  const actual = await importActual<typeof import("../openclaw-executor.js")>();
  return {
    ...actual,
    runAgentFromSpawnRequest: (api: unknown, sr: SpawnRequest) =>
      mockRunAgentFromSpawnRequest(api, sr),
  };
});

// Suppress pino noise — not required for correctness but keeps test output clean.
vi.mock("../../logging/index.js", async (importActual) => {
  const actual = await importActual<typeof import("../../logging/index.js")>();
  const quiet = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { ...actual, createLogger: () => quiet };
});

import { startSpawnPollerOnce, stopSpawnPoller, isSpawnPollerStarted } from "../spawn-poller.js";
import type { DaemonIpcClient } from "../daemon-ipc-client.js";
import type { OpenClawApi } from "../types.js";

function makeSpawnRequest(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    id: "spawn-1",
    taskId: "task-1",
    taskPath: "/tmp/tasks/ready/task-1.md",
    agent: "swe-backend",
    priority: "normal",
    routing: {},
    callbackDepth: 0,
    ...overrides,
  };
}

/**
 * Build a mock `DaemonIpcClient` whose `waitForSpawn` is a user-controlled
 * queue — each call consumes the next scripted response.
 */
function makeMockClient(): {
  client: DaemonIpcClient;
  enqueueWait: (r: SpawnRequest | undefined | Error) => void;
  postedResults: Array<{ id: string; result: SpawnResultPost }>;
  waitCallCount: () => number;
} {
  const queue: Array<SpawnRequest | undefined | Error> = [];
  const postedResults: Array<{ id: string; result: SpawnResultPost }> = [];
  let waitCalls = 0;

  const client = {
    waitForSpawn: async (): Promise<SpawnRequest | undefined> => {
      waitCalls += 1;
      // Wait for a response to be enqueued. In tests we enqueue synchronously
      // before `startSpawnPollerOnce`, so this resolves on first tick.
      while (queue.length === 0) {
        await new Promise((r) => setTimeout(r, 1));
      }
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    postSpawnResult: async (id: string, result: SpawnResultPost): Promise<void> => {
      postedResults.push({ id, result });
    },
    // Not exercised by these tests but must exist to satisfy the type.
    invokeTool: vi.fn(),
    postSessionEnd: vi.fn(),
    postAgentEnd: vi.fn(),
    postBeforeCompaction: vi.fn(),
    postMessageReceived: vi.fn(),
    selfCheck: vi.fn(),
    socketPath: "/tmp/daemon.sock",
  } as unknown as DaemonIpcClient;

  return {
    client,
    enqueueWait: (r) => queue.push(r),
    postedResults,
    waitCallCount: () => waitCalls,
  };
}

const fakeApi: OpenClawApi = {
  config: { agents: {} },
  registerService: vi.fn(),
  registerTool: vi.fn(),
  on: vi.fn(),
} as unknown as OpenClawApi;

describe("spawn-poller", () => {
  beforeEach(() => {
    // Reset module-level singleton between tests.
    stopSpawnPoller();
    mockRunAgentFromSpawnRequest.mockReset();
  });

  afterEach(() => {
    stopSpawnPoller();
  });

  it("invokes runAgentFromSpawnRequest for each received SpawnRequest and posts the result", async () => {
    const { client, enqueueWait, postedResults } = makeMockClient();
    mockRunAgentFromSpawnRequest.mockResolvedValueOnce({
      sessionId: "real-sess-1",
      success: true,
      aborted: false,
      durationMs: 42,
    });

    const sr = makeSpawnRequest({ id: "spawn-A", taskId: "TASK-A" });
    enqueueWait(sr);

    startSpawnPollerOnce(client, fakeApi);

    await vi.waitFor(() => expect(postedResults.length).toBe(1), { timeout: 2_000 });
    expect(mockRunAgentFromSpawnRequest).toHaveBeenCalledWith(fakeApi, sr);
    expect(postedResults[0]?.id).toBe("spawn-A");
    expect(postedResults[0]?.result.sessionId).toBe("real-sess-1");
    expect(postedResults[0]?.result.success).toBe(true);
  });

  it("does nothing on HTTP 204 (undefined return) — no handler, no post", async () => {
    const { client, enqueueWait, postedResults, waitCallCount } = makeMockClient();
    enqueueWait(undefined);
    enqueueWait(undefined);

    startSpawnPollerOnce(client, fakeApi);

    await vi.waitFor(() => expect(waitCallCount()).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect(mockRunAgentFromSpawnRequest).not.toHaveBeenCalled();
    expect(postedResults).toHaveLength(0);
  });

  it("Pitfall 3: startSpawnPollerOnce is idempotent — second call is a no-op", async () => {
    const { client, enqueueWait, waitCallCount } = makeMockClient();
    enqueueWait(undefined);

    startSpawnPollerOnce(client, fakeApi);
    expect(isSpawnPollerStarted()).toBe(true);

    // Second start — should NOT spin up a second loop.
    startSpawnPollerOnce(client, fakeApi);

    // Wait for at least one poll to happen.
    await vi.waitFor(() => expect(waitCallCount()).toBeGreaterThanOrEqual(1), { timeout: 2_000 });
    // A moment later, only one loop is running — we enqueue a single 204 per
    // iteration, so the count should grow only as fast as a single loop drains.
    const calls1 = waitCallCount();
    enqueueWait(undefined);
    await vi.waitFor(() => expect(waitCallCount()).toBe(calls1 + 1), { timeout: 2_000 });
    // If two loops were active we'd see waitCallCount jump by ≥2 per enqueue.
  });

  it("posts an exception SpawnResultPost when runAgentFromSpawnRequest throws", async () => {
    const { client, enqueueWait, postedResults } = makeMockClient();
    mockRunAgentFromSpawnRequest.mockRejectedValueOnce(new Error("boom"));

    enqueueWait(makeSpawnRequest({ id: "spawn-ERR" }));

    startSpawnPollerOnce(client, fakeApi);

    await vi.waitFor(() => expect(postedResults.length).toBe(1), { timeout: 2_000 });
    expect(postedResults[0]?.id).toBe("spawn-ERR");
    expect(postedResults[0]?.result.success).toBe(false);
    expect(postedResults[0]?.result.error?.kind).toBe("exception");
    expect(postedResults[0]?.result.error?.message).toContain("boom");
  });

  it("retries with exponential backoff on socket errors without crashing the loop", async () => {
    const { client, enqueueWait, postedResults } = makeMockClient();
    // First poll fails transiently; second poll returns a spawn.
    enqueueWait(new Error("ECONNREFUSED"));
    mockRunAgentFromSpawnRequest.mockResolvedValueOnce({
      sessionId: "recovered",
      success: true,
      aborted: false,
      durationMs: 5,
    });
    enqueueWait(makeSpawnRequest({ id: "spawn-R" }));

    startSpawnPollerOnce(client, fakeApi);

    // We allow up to the 1s initial backoff plus safety — expect recovery.
    await vi.waitFor(() => expect(postedResults.length).toBe(1), { timeout: 3_000 });
    expect(postedResults[0]?.id).toBe("spawn-R");
    expect(isSpawnPollerStarted()).toBe(true);
  });
});
