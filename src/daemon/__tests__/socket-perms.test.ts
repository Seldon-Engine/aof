/**
 * Socket permission tests — Wave 0 RED anchor turned GREEN.
 *
 * T-43-01 (threat register, 43-03-PLAN.md): daemon.sock must be created with
 * mode 0600 so only the invoking user can connect. This test asserts the
 * invariant under `startAofDaemon`, not just the raw server helper, so we
 * detect regressions in any wrapper code that might chmod the socket later.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { startAofDaemon } from "../daemon.js";
import type { PollResult } from "../../dispatch/scheduler.js";

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

const makePollResult = (): PollResult => ({
  scannedAt: new Date().toISOString(),
  durationMs: 1,
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
});

describe("daemon.sock permissions", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-sockperm-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eDir = join(tmpDir, "events");
    await mkdir(eDir, { recursive: true });
    logger = new EventLogger(eDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates daemon.sock with mode 0600 (owner rw only)", async () => {
    const socketPath = join(tmpDir, "daemon.sock");
    const poller = vi.fn(async () => makePollResult());

    const { service, healthServer } = await startAofDaemon({
      dataDir: tmpDir,
      pollIntervalMs: 60_000,
      dryRun: true,
      store,
      logger,
      poller,
      enableHealthServer: true,
      socketPath,
    });

    try {
      const info = await stat(socketPath);
      // Mask off non-permission bits; only the lower 9 bits are mode.
      const mode = info.mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      if (healthServer) healthServer.close();
      await service.stop();
    }
  });
});
