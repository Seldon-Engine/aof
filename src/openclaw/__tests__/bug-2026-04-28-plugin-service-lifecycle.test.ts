/**
 * BUG-2026-04-28: AOF's plugin started its long-poll loops directly inside
 * `register(api)`, which OpenClaw invokes in every Node process that loads
 * the plugin (gateway main + each per-session worker). The pollers'
 * `await client.waitForSpawn(30s)` keeps a Node socket handle alive
 * forever, so each worker process leaked: 11 alive plugin-loaded PIDs were
 * counted on 2026-04-28 (1 gateway + 10 worker zombies), each holding its
 * own pair of idle long-poll handles.
 *
 * The fix is to register the pollers as plugin services (`api.registerService`)
 * with proper start/stop. OpenClaw's `startPluginServices`
 * (`~/Projects/openclaw/src/plugins/services.ts`) is invoked exactly once,
 * by the gateway main process during boot
 * (`~/Projects/openclaw/src/gateway/server-startup.ts`). Worker processes
 * never call `startPluginServices`, so wrapping the pollers in services
 * confines their startup to the one process that owns the dispatch bridge.
 *
 * This regression test asserts:
 *   - registerAofPlugin does NOT eagerly start the pollers (no module-level
 *     side effect during register).
 *   - Both pollers are registered as services with the expected ids.
 *   - The service `start` callback starts the corresponding poller.
 *   - The service `stop` callback stops it.
 *
 * See .planning/debug/2026-04-28-aof-dispatch-ghosting-and-worker-hygiene.md
 * for the investigation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

import { registerAofPlugin } from "../adapter.js";
import { isSpawnPollerStarted, stopSpawnPoller } from "../spawn-poller.js";
import { isChatDeliveryPollerStarted, stopChatDeliveryPoller } from "../chat-delivery-poller.js";
import { resetDaemonIpcClient } from "../daemon-ipc-client.js";
import type { OpenClawApi, OpenClawServiceDefinition, OpenClawPluginServiceContext } from "../types.js";
import type { DaemonIpcClient } from "../daemon-ipc-client.js";
import type { InvokeToolResponse } from "../../ipc/schemas.js";

function makeMockClient(): DaemonIpcClient {
  return {
    invokeTool: vi.fn(
      async (_env: unknown): Promise<InvokeToolResponse> => ({ result: { ok: true } }),
    ),
    // Both pollers' loops await waitForX with a never-resolving promise so
    // the loop parks on await — the start gate will still flip to true
    // synchronously, which is what we assert against.
    waitForSpawn: vi.fn(() => new Promise<undefined>(() => {})),
    waitForChatDelivery: vi.fn(() => new Promise<undefined>(() => {})),
    postSpawnResult: vi.fn(async () => undefined),
    postChatDeliveryResult: vi.fn(async () => undefined),
    postSessionEnd: vi.fn(async () => undefined),
    postAgentEnd: vi.fn(async () => undefined),
    postBeforeCompaction: vi.fn(async () => undefined),
    postMessageReceived: vi.fn(async () => undefined),
    selfCheck: vi.fn(async () => true),
    socketPath: "/tmp/fake.sock",
  } as unknown as DaemonIpcClient;
}

function fakeServiceContext(): OpenClawPluginServiceContext {
  return {
    config: {},
    workspaceDir: "/tmp/workspace",
    stateDir: "/tmp/state",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

describe("BUG-2026-04-28 — plugin service lifecycle for pollers", () => {
  beforeEach(() => {
    // Confirm clean module state before each test. If a prior test left a
    // poller running, its waitForSpawn never resolves and the next test's
    // `start` would early-return (idempotency gate), masking the bug.
    stopSpawnPoller();
    stopChatDeliveryPoller();
    resetDaemonIpcClient();
  });

  afterEach(() => {
    stopSpawnPoller();
    stopChatDeliveryPoller();
    resetDaemonIpcClient();
  });

  it("registerAofPlugin does NOT start the pollers eagerly", () => {
    const services: OpenClawServiceDefinition[] = [];
    const api: OpenClawApi = {
      registerService: (def) => services.push(def),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    expect(isSpawnPollerStarted()).toBe(false);
    expect(isChatDeliveryPollerStarted()).toBe(false);

    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: makeMockClient(),
    });

    // The fix: register-time must be a no-op for poller startup. The
    // bug we're guarding against is the inverse — `startSpawnPollerOnce`
    // being called directly during register().
    expect(isSpawnPollerStarted()).toBe(false);
    expect(isChatDeliveryPollerStarted()).toBe(false);

    // Both pollers were registered as services.
    expect(services.map((s) => s.id).sort()).toEqual([
      "aof-chat-delivery-poller",
      "aof-spawn-poller",
    ]);
  });

  it("service.start() starts the corresponding poller; service.stop() stops it", async () => {
    const services: OpenClawServiceDefinition[] = [];
    const api: OpenClawApi = {
      registerService: (def) => services.push(def),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: makeMockClient(),
    });

    const spawn = services.find((s) => s.id === "aof-spawn-poller");
    const chat = services.find((s) => s.id === "aof-chat-delivery-poller");
    expect(spawn).toBeDefined();
    expect(chat).toBeDefined();

    const ctx = fakeServiceContext();

    // start
    await spawn!.start(ctx);
    await chat!.start(ctx);
    expect(isSpawnPollerStarted()).toBe(true);
    expect(isChatDeliveryPollerStarted()).toBe(true);

    // stop
    await spawn!.stop?.(ctx);
    await chat!.stop?.(ctx);
    expect(isSpawnPollerStarted()).toBe(false);
    expect(isChatDeliveryPollerStarted()).toBe(false);
  });
});
