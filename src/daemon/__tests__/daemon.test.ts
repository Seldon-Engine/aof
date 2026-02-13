import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";
import { startAofDaemon } from "../daemon.js";
import type { PollResult } from "../../dispatch/scheduler.js";

describe("AOF daemon", () => {
  let tmpDir: string;
  let store: TaskStore;
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
    tmpDir = await mkdtemp(join(tmpdir(), "aof-daemon-test-"));
    store = new TaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts the daemon loop with a poll", async () => {
    const poller = vi.fn(async () => makePollResult());

    const service = await startAofDaemon({
      dataDir: tmpDir,
      pollIntervalMs: 60_000,
      dryRun: true,
      store,
      logger,
      poller,
    });

    expect(poller).toHaveBeenCalledTimes(1);

    await service.stop();
  });
});
