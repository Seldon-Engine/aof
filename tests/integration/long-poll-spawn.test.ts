/**
 * Phase 43 — D-09 long-poll spawn callback (RED scaffold, Wave 0).
 *
 * Covers the 4 sub-cases for `GET /v1/spawns/wait`:
 *   A) Enqueue-before-poll: daemon already has a pending spawn; plugin's long-
 *      poll returns it immediately.
 *   B) Enqueue-after-poll: plugin opens long-poll first; daemon enqueues 100ms
 *      later; plugin receives the request.
 *   C) Keepalive → 204: plugin opens long-poll, no enqueue within the server-
 *      side keepalive window (~25s); server sends 204, plugin sees undefined.
 *   D) Plugin drops mid-poll: plugin aborts its request mid-flight; daemon's
 *      spawn-queue must not leak listeners (Pitfall 2 — single cleanup path).
 *
 * RED status: Wave 0 scaffold. The `/v1/spawns/wait` route and `SpawnQueue`
 *   helpers don't exist yet (Wave 2 lands them). These tests fail with 404 or
 *   listener-count 0 until then. `AOF_INTEGRATION=1` is required; npm test
 *   (no gate) skips the whole block.
 *
 * Sub-case D test hook: asserting `spawnQueue.listenerCount("enqueue") === 0`
 *   requires a test-only accessor on the daemon. Until Wave 2 exposes one,
 *   that sub-case is it.skip'd with a TODO pointing at the Wave-2 exposure.
 *   Documented in 43-02-SUMMARY.md.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request as httpRequest } from "node:http";

import {
  startTestDaemon,
  type TestDaemon,
} from "./helpers/daemon-harness.js";
import { waitForSpawn } from "./helpers/plugin-ipc-client.js";

const SHOULD_RUN = process.env.AOF_INTEGRATION === "1";

/**
 * Helper: reach into the daemon's wave-2 SpawnQueue to enqueue a test
 * SpawnRequest. Until Wave 2 wires the queue onto the service / ipc deps, this
 * helper throws — tests that depend on it will fail RED.
 */
function enqueueTestSpawn(daemon: TestDaemon, payload: Record<string, unknown>): string {
  // Cast through `any` because Wave 2 adds the `spawnQueue` field; until then
  // the access throws, which is exactly the RED failure we want.
  const queue = (daemon.service as unknown as { spawnQueue?: {
    enqueue(p: Record<string, unknown>): { id: string };
  }; }).spawnQueue;
  if (!queue) {
    throw new Error(
      "daemon.service.spawnQueue unavailable (Wave 2 will expose it)",
    );
  }
  const sr = queue.enqueue(payload);
  return sr.id;
}

describe.skipIf(!SHOULD_RUN)(
  "Phase 43 — long-poll spawn (D-09)",
  () => {
    let daemon: TestDaemon;

    beforeEach(async () => {
      daemon = await startTestDaemon();
    });

    afterEach(async () => {
      await daemon.stop();
    });

    it("sub-case A: enqueue-before-poll returns spawn immediately", async () => {
      const spawnId = enqueueTestSpawn(daemon, {
        taskId: "test-task-A",
        agent: "test-agent",
      });

      const sr = await waitForSpawn(daemon.socketPath, 5_000);
      expect(sr).toBeDefined();
      expect(sr?.id).toBe(spawnId);
    });

    it("sub-case B: enqueue-after-poll delivers spawn via long-poll", async () => {
      const waitPromise = waitForSpawn(daemon.socketPath, 10_000);

      let spawnId: string | undefined;
      setTimeout(() => {
        try {
          spawnId = enqueueTestSpawn(daemon, {
            taskId: "test-task-B",
            agent: "test-agent",
          });
        } catch {
          // Wave 2 failure — test remains RED.
        }
      }, 100);

      const sr = await waitPromise;
      expect(sr).toBeDefined();
      expect(sr?.id).toBe(spawnId);
    });

    it(
      "sub-case C: keepalive window → 204 → undefined",
      async () => {
        // No enqueue. Server-side keepalive window is ~25s; we allow the
        // client a generous 35s ceiling so the 204 path is observed.
        const sr = await waitForSpawn(daemon.socketPath, 35_000);
        expect(sr).toBeUndefined();
      },
      40_000,
    );

    it.skip(
      "sub-case D: plugin drop mid-poll leaves zero enqueue listeners (Wave 2 hook)",
      async () => {
        // TODO (Wave 2): expose daemon.service.spawnQueue test accessor so we
        // can assert `listenerCount("enqueue") === 0` after client abort.
        // Once exposed, uncomment:
        //
        // const controller = new AbortController();
        // const req = httpRequest(
        //   { socketPath: daemon.socketPath, path: "/v1/spawns/wait", method: "GET" },
        //   () => { /* not expected to respond */ },
        // );
        // req.end();
        // setTimeout(() => req.destroy(), 50);
        // await new Promise((r) => setTimeout(r, 200));
        // const queue = (daemon.service as any).spawnQueue;
        // expect(queue.listenerCount("enqueue")).toBe(0);
        void httpRequest;
        expect(true).toBe(true);
      },
    );
  },
);
