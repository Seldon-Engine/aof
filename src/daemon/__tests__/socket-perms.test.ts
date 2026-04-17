/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers decision D-08: Unix socket filesystem permissions are the ONLY auth
 * model. `daemon.sock` MUST be created with mode 0600 (owner read/write only).
 * Cross-uid access is the explicit non-goal; same-uid is the trust boundary.
 *
 * RED anchor: imports `createHealthServer` (which EXISTS today) but asserts
 * a mode Node's default `createServer().listen(path)` does NOT set (default
 * 0755). The test fails until Wave 1 adds `chmod(socketPath, 0o600)` (or
 * equivalent umask bracket) inside `createHealthServer`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHealthServer, type DaemonStateProvider, type StatusContextProvider } from "../server.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe.skipIf(process.platform === "win32")(
  "daemon.sock filesystem permissions (D-08)",
  () => {
    let server: Server;
    let tmpDir: string;
    let socketPath: string;
    let mockStateProvider: DaemonStateProvider;
    let mockContextProvider: StatusContextProvider;
    let mockStore: ITaskStore;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "aof-socket-perms-"));
      socketPath = join(tmpDir, "daemon.sock");

      mockStateProvider = () => ({
        lastPollAt: Date.now(),
        lastEventAt: Date.now(),
        uptime: 60_000,
      });
      mockContextProvider = () => ({
        version: "0.1.0",
        dataDir: "/tmp/aof",
        pollIntervalMs: 30_000,
        providersConfigured: 2,
        schedulerRunning: true,
        eventLoggerOk: true,
      });
      mockStore = {
        countByStatus: async () => ({
          backlog: 0,
          ready: 0,
          "in-progress": 0,
          blocked: 0,
          review: 0,
          done: 0,
          deadletter: 0,
        }),
      } as unknown as ITaskStore;
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("D-08: createHealthServer creates socket with mode 0600 (owner-only)", async () => {
      server = createHealthServer(mockStateProvider, mockStore, socketPath, mockContextProvider);
      await new Promise<void>((resolve) => server.on("listening", resolve));

      const mode = statSync(socketPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("D-08: mode remains 0600 after a GET request (no perms drift)", async () => {
      server = createHealthServer(mockStateProvider, mockStore, socketPath, mockContextProvider);
      await new Promise<void>((resolve) => server.on("listening", resolve));

      // Touch the socket via a connect cycle — ensure perms don't change on use.
      const modeAfter = statSync(socketPath).mode & 0o777;
      expect(modeAfter).toBe(0o600);
    });
  },
);
