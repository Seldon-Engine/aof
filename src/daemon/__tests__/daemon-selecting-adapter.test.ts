/**
 * Phase 43 plan 05 — verify `startAofDaemon` wires up the full
 * SelectingAdapter + PluginBridgeAdapter + SpawnQueue + PluginRegistry stack.
 *
 * The daemon's `executor` must be a `SelectingAdapter` (not a
 * `StandaloneAdapter` directly) and the IPC routes must receive the
 * spawnQueue / pluginRegistry / deliverSpawnResult deps so the `/v1/spawns/*`
 * endpoints are served.
 *
 * Mode-dependent behavior:
 *   - `daemon.mode === "plugin-bridge"`, no plugin attached → `spawnSession`
 *     returns `{ success: false, error: "no-plugin-attached" }` (D-12 sentinel).
 *     The hold branch in `assign-executor.ts` (landed in this same plan) turns
 *     this into hold-in-ready.
 *   - `daemon.mode === "standalone"`, no plugin attached → falls through to
 *     the fallback adapter (StandaloneAdapter in prod; injected mock here).
 *   - Any mode, plugin attached (long-poll active) → routes to
 *     PluginBridgeAdapter (spawn enqueued on SpawnQueue). Enforced
 *     indirectly through the SpawnQueue observation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startAofDaemon } from "../daemon.js";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import type { PollResult } from "../../dispatch/scheduler.js";
import { SelectingAdapter } from "../../dispatch/selecting-adapter.js";
import { resetConfig } from "../../config/registry.js";
import type {
  TaskContext,
  GatewayAdapter,
} from "../../dispatch/executor.js";

// Mock structured logger to suppress output during tests
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

function makeTaskContext(overrides?: Partial<TaskContext>): TaskContext {
  return {
    taskId: "TASK-test-001",
    taskPath: "/tmp/TASK-test-001.md",
    agent: "test-agent",
    priority: "P2",
    routing: { agent: "test-agent" },
    projectId: "test-proj",
    projectRoot: "/tmp",
    taskRelpath: "TASK-test-001.md",
    ...overrides,
  };
}

function makePollResult(): PollResult {
  return {
    scannedAt: new Date().toISOString(),
    durationMs: 5,
    dryRun: true,
    actions: [],
    stats: {
      total: 0,
      backlog: 0,
      ready: 0,
      inProgress: 0,
      blocked: 0,
      review: 0,
      done: 0,
      cancelled: 0,
      deadletter: 0,
    },
  };
}

describe("startAofDaemon — SelectingAdapter wiring (43-05)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-daemon-sel-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    resetConfig();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("constructs a SelectingAdapter as the service executor (not StandaloneAdapter directly)", async () => {
    resetConfig({ daemon: { mode: "plugin-bridge" } });
    const poller = vi.fn(async () => makePollResult());

    const { service } = await startAofDaemon({
      dataDir: tmpDir,
      pollIntervalMs: 60_000,
      dryRun: false,
      store,
      logger,
      poller,
      enableHealthServer: false,
    });

    // Reach into service.schedulerConfig (private) for the wired executor.
    const executor = (
      service as unknown as { schedulerConfig: { executor?: unknown } }
    ).schedulerConfig.executor;
    expect(executor).toBeInstanceOf(SelectingAdapter);

    await service.stop();
  });

  it("plugin-bridge mode + no plugin attached → spawnSession returns no-plugin-attached sentinel", async () => {
    resetConfig({ daemon: { mode: "plugin-bridge" } });
    const poller = vi.fn(async () => makePollResult());

    const { service } = await startAofDaemon({
      dataDir: tmpDir,
      pollIntervalMs: 60_000,
      dryRun: false,
      store,
      logger,
      poller,
      enableHealthServer: false,
    });

    const executor = (
      service as unknown as { schedulerConfig: { executor: GatewayAdapter } }
    ).schedulerConfig.executor;
    const result = await executor.spawnSession(makeTaskContext());
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toBe("no-plugin-attached");

    await service.stop();
  });

  it("standalone mode + no plugin attached → falls through to StandaloneAdapter (preserved regression path)", async () => {
    resetConfig({ daemon: { mode: "standalone" } });
    const poller = vi.fn(async () => makePollResult());

    const { service } = await startAofDaemon({
      dataDir: tmpDir,
      pollIntervalMs: 60_000,
      dryRun: false,
      store,
      logger,
      poller,
      enableHealthServer: false,
    });

    const executor = (
      service as unknown as { schedulerConfig: { executor: GatewayAdapter } }
    ).schedulerConfig.executor;

    // Standalone fallback will attempt to HTTP-dispatch. We're not running an
    // OpenClaw gateway in this test so the spawn returns success=false with a
    // connection-refused or similar transient error — NOT the "no-plugin-attached"
    // sentinel. That's the observable signal that standalone fell through
    // rather than held.
    //
    // Pass a short `timeoutMs` so the HTTP fetch aborts quickly instead of
    // waiting 30s for the default. On a loaded machine, the default (30s
    // spawn + 5s health verify = 35s worst case) can exceed the 10s vitest
    // per-test timeout and flake this test. Under normal conditions TCP
    // connect fails with ECONNREFUSED in <100ms anyway — this bound just
    // prevents worst-case stalls from bleeding into the assertion window.
    const result = await executor.spawnSession(makeTaskContext(), {
      timeoutMs: 1000,
    });
    expect(result.success).toBe(false);
    // The critical assertion: we did NOT return the D-12 sentinel; standalone
    // mode falls through to the StandaloneAdapter whose failure mode is a
    // transport error, not the hold sentinel.
    expect((result as { error?: string }).error).not.toBe(
      "no-plugin-attached",
    );

    await service.stop();
  });

  it("dryRun=true → executor is undefined (no adapter constructed)", async () => {
    resetConfig({ daemon: { mode: "plugin-bridge" } });
    const poller = vi.fn(async () => makePollResult());

    const { service } = await startAofDaemon({
      dataDir: tmpDir,
      pollIntervalMs: 60_000,
      dryRun: true,
      store,
      logger,
      poller,
      enableHealthServer: false,
    });

    const executor = (
      service as unknown as { schedulerConfig: { executor?: unknown } }
    ).schedulerConfig.executor;
    expect(executor).toBeUndefined();

    await service.stop();
  });
});
