/**
 * Phase 43 — D-12 hold-in-ready when no plugin attached (RED scaffold, Wave 0).
 *
 * Core invariant (PROJECT.md): "Tasks never get dropped." When the daemon is
 * running in plugin-bridge mode and no plugin is currently long-polling, a
 * `ready/` task must:
 *   - Stay in `ready/` (not move to blocked, deadletter, in-progress, done).
 *   - Emit a `dispatch.held` event with `reason: "no-plugin-attached"`.
 *   - Once a plugin long-polls, be dispatched on the next poll.
 *
 * RED status: Wave 0 scaffold. D-12 logic lives in `assign-executor.ts` + a
 *   new `SelectingAdapter`; neither lands until Wave 2. Tests fail RED until
 *   those ship. `AOF_INTEGRATION=1` required.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

import {
  startTestDaemon,
  type TestDaemon,
} from "./helpers/daemon-harness.js";
import { waitForSpawn } from "./helpers/plugin-ipc-client.js";

const SHOULD_RUN = process.env.AOF_INTEGRATION === "1";

/**
 * Minimal ready-task fixture. The scheduler reads tasks/ready/*.md; we write a
 * tiny, frontmattered task file so the scheduler picks it up on the next poll.
 */
function writeReadyTask(dataDir: string, taskId: string): string {
  const readyDir = join(dataDir, "tasks", "ready");
  mkdirSync(readyDir, { recursive: true });
  const path = join(readyDir, `${taskId}.md`);
  const body = [
    "---",
    `id: ${taskId}`,
    "title: phase-43-02 hold-no-plugin fixture",
    "agent: test-agent",
    "priority: P2",
    "status: ready",
    "---",
    "",
    "Fixture for hold-no-plugin integration spec (RED until Wave 2).",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf-8");
  return path;
}

function readReadyTaskIds(dataDir: string): string[] {
  const readyDir = join(dataDir, "tasks", "ready");
  if (!existsSync(readyDir)) return [];
  return readdirSync(readyDir).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, ""));
}

describe.skipIf(!SHOULD_RUN)(
  "Phase 43 — hold task when no plugin attached (D-12)",
  () => {
    let daemon: TestDaemon;

    beforeEach(async () => {
      // dryRun=false so the scheduler actually tries to dispatch; daemon.mode
      // will be "plugin-bridge" via a Wave-2 config override (today it
      // defaults to "standalone", which makes this test RED).
      daemon = await startTestDaemon({ dryRun: false });
    });

    afterEach(async () => {
      await daemon.stop();
    });

    it(
      "holds task in ready/ and emits dispatch.held when no plugin attached (no-plugin-attached)",
      async () => {
        const taskId = `hold-43-02-${Date.now()}`;
        writeReadyTask(daemon.dataDir, taskId);

        // Trigger a poll and wait a beat for the scheduler to process it.
        // Once Wave 2 lands, `service.triggerPoll()` (or an equivalent test
        // hook) will force the scheduler to evaluate the fixture immediately.
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        // Assert 1: task still in ready/ — NOT moved to blocked, in-progress,
        //           deadletter, or done.
        expect(readReadyTaskIds(daemon.dataDir)).toContain(taskId);

        // Assert 2: dispatch.held event emitted with the expected reason.
        // Event log lives at `{dataDir}/events/events-YYYY-MM-DD.jsonl`.
        // We scan the newest file for the sentinel payload.
        const eventsDir = join(daemon.dataDir, "events");
        const files = existsSync(eventsDir)
          ? readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"))
          : [];
        let foundHeld = false;
        for (const f of files) {
          const content = readFileSafe(join(eventsDir, f));
          if (content.includes("dispatch.held") && content.includes("no-plugin-attached")) {
            foundHeld = true;
            break;
          }
        }
        expect(foundHeld).toBe(true);
      },
    );

    it(
      "dispatches task once a plugin attaches via long-poll",
      async () => {
        const taskId = `hold-then-dispatch-43-02-${Date.now()}`;
        writeReadyTask(daemon.dataDir, taskId);

        // Open a long-poll — this implicitly registers the plugin (D-11).
        const waitPromise = waitForSpawn(daemon.socketPath, 10_000);

        // Wait for the scheduler to see the plugin and dispatch.
        const sr = await waitPromise;
        expect(sr).toBeDefined();
        expect(sr?.taskId).toBe(taskId);
      },
      15_000,
    );
  },
);

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
