import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { AOFService } from "../aof-service.js";
import type { PollResult } from "../../dispatch/scheduler.js";
import type { GatewayAdapter } from "../../dispatch/executor.js";

describe("AOFService ProtocolRouter wiring", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  const makePollResult = (): PollResult => ({
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
    },
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-router-wiring-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes executor to ProtocolRouter when provided in deps", () => {
    const mockExecutor: GatewayAdapter = {
      spawnSession: vi.fn(),
    };
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller, executor: mockExecutor },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    // Access the internally-created ProtocolRouter to verify executor was forwarded
    const router = (service as any).protocolRouter;
    expect((router as any).executor).toBe(mockExecutor);
  });

  it("ProtocolRouter has undefined executor when not provided in deps", () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    const router = (service as any).protocolRouter;
    expect((router as any).executor).toBeUndefined();
  });

  it("passes spawnTimeoutMs from config to ProtocolRouter", () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true, spawnTimeoutMs: 15_000 },
    );

    const router = (service as any).protocolRouter;
    expect((router as any).spawnTimeoutMs).toBe(15_000);
  });

  it("ProtocolRouter uses default spawnTimeoutMs when not configured", () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    const router = (service as any).protocolRouter;
    // Default is 30_000 from ProtocolRouter constructor
    expect((router as any).spawnTimeoutMs).toBe(30_000);
  });
});
