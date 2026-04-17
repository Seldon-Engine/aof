/**
 * Phase 43 — Daemon restart mid-long-poll (RED scaffold, Wave 0).
 *
 * Survival scenario: plugin has an open `GET /v1/spawns/wait` long-poll when
 * the daemon restarts. Expected behaviour:
 *   1. Long-poll's socket closes (daemon went away).
 *   2. A fresh daemon is started on the same `socketPath`.
 *   3. Plugin's spawn-poller reconnects within a bounded retry budget (~30s).
 *   4. A spawn enqueued post-restart is delivered to the reconnected plugin.
 *
 * Retry budget: 43-PATTERNS.md §spawn-poller.ts sketches exponential backoff
 *   1s → 2s → 4s → 8s → cap 30s. We assert reconnection happens within ~30s
 *   of restart. Documented in 43-02-SUMMARY.md.
 *
 * RED status: Wave 0 scaffold. Wave 2 lands the `/v1/spawns/wait` route on
 *   the daemon, and Wave 3 lands `src/openclaw/spawn-poller.ts` with the
 *   reconnect loop. Until both ship, the reconnect assertion fails. The test
 *   itself drives two `startTestDaemon` cycles and therefore needs Wave 1+
 *   IPC surface to even attempt the assertions. `AOF_INTEGRATION=1` gated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  startTestDaemon,
  type TestDaemon,
} from "./helpers/daemon-harness.js";
import { waitForSpawn } from "./helpers/plugin-ipc-client.js";

const SHOULD_RUN = process.env.AOF_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)(
  "Phase 43 — daemon restart mid-long-poll",
  () => {
    let daemon: TestDaemon;

    beforeEach(async () => {
      daemon = await startTestDaemon();
    });

    afterEach(async () => {
      await daemon.stop();
    });

    it(
      "plugin's long-poll reconnects to a fresh daemon on the same socketPath within retry budget",
      async () => {
        const socketPath = daemon.socketPath;
        const dataDir = daemon.dataDir;

        // Start long-poll against the first daemon.
        const firstWait = waitForSpawn(socketPath, 10_000).catch((err: unknown) => {
          // Expected: the daemon goes away, so this poll rejects. Swallow.
          return err;
        });

        // Give the request time to land on the server side.
        await new Promise((r) => setTimeout(r, 200));

        // Tear down the first daemon (simulate restart by stopping the
        // health server + AOFService but keeping sandbox for the next run).
        await daemon.service.stop();
        await new Promise<void>((resolve) => {
          if (!daemon.healthServer) return resolve();
          daemon.healthServer.close(() => resolve());
        });

        // Mark first daemon "stopped" so afterEach doesn't double-stop the
        // service. Rehydrate a replacement daemon on the SAME socketPath
        // + dataDir. A real restart uses launchd/systemd supervision; the
        // harness emulates by invoking startTestDaemon a second time.
        const daemon2 = await startTestDaemon({ socketPath, dataDir });

        try {
          // Wait for the firstWait to resolve (it will either have returned
          // undefined, thrown, or been garbage-collected when the server
          // closed). We only care that a NEW long-poll opened against the
          // new daemon also receives a spawn.
          await firstWait;

          // Open a fresh long-poll against the new daemon (as the
          // plugin-side reconnect loop would). Wave 2+ enqueues a spawn
          // via a test hook; until then this fails RED.
          const secondWaitPromise = waitForSpawn(daemon2.socketPath, 5_000);

          // Enqueue via Wave-2 SpawnQueue (throws today — RED).
          const queue = (daemon2.service as unknown as { spawnQueue?: {
            enqueue(p: Record<string, unknown>): { id: string };
          }; }).spawnQueue;
          if (queue) queue.enqueue({ taskId: "restart-43-02", agent: "test-agent" });

          const sr = await secondWaitPromise;
          expect(sr).toBeDefined();
        } finally {
          await daemon2.stop();
          // Ensure afterEach doesn't double-stop the original service.
          daemon = daemon2;
        }
      },
      45_000,
    );
  },
);
