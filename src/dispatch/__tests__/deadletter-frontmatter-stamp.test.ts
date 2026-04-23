/**
 * BUG-005 (partial): when a task reaches deadletter, stamp the failure
 * cause into the task's own frontmatter metadata so coordinators don't
 * need to chase events.jsonl to figure out *why*. The status_report tool
 * reads task metadata; an operator triaging a deadlettered task should
 * see the reason without running a log tool.
 *
 * The cancel path already supports a coordinator override:
 * `aof_task_cancel(taskId, reason="superseded: ...")` works from any
 * non-terminal state including `deadletter`, and the reason is written
 * to `metadata.cancellationReason`. That covers the user-side
 * "mark it done elsewhere" workflow without introducing a new
 * terminal state in the task lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { transitionToDeadletter } from "../failure-tracker.js";

describe("deadletter frontmatter stamp (BUG-005)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug005-"));
    logger = new EventLogger(join(tmpDir, "events"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes deadletter cause into task metadata (not just the event log)", async () => {
    const task = await store.create({
      title: "deadletter candidate",
      body: "b",
      createdBy: "test",
      routing: { agent: "swe-frontend" },
    });
    // Walk through dispatch lifecycle to reach a transitionable state.
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "blocked");

    // Simulate the failure counter having accumulated.
    const pre = await store.get(task.frontmatter.id);
    pre!.frontmatter.metadata = {
      ...pre!.frontmatter.metadata,
      dispatchFailures: 3,
      errorClass: "transient",
    };
    await store.save(pre!);

    await transitionToDeadletter(
      store,
      logger,
      task.frontmatter.id,
      'Agent error: exception: No API key found for provider "openai"',
    );

    const after = await store.get(task.frontmatter.id);
    expect(after?.frontmatter.status).toBe("deadletter");
    expect(after?.frontmatter.metadata.deadletterReason).toBe("max_dispatch_failures");
    expect(after?.frontmatter.metadata.deadletterLastError).toMatch(/No API key/);
    expect(after?.frontmatter.metadata.deadletterErrorClass).toBe("transient");
    expect(after?.frontmatter.metadata.deadletterFailureCount).toBe(3);
    expect(typeof after?.frontmatter.metadata.deadletterAt).toBe("string");
  });

  it("reports 'permanent_error' reason when errorClass is permanent", async () => {
    const task = await store.create({
      title: "permanent-failure candidate",
      body: "b",
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "blocked");

    const pre = await store.get(task.frontmatter.id);
    pre!.frontmatter.metadata = {
      ...pre!.frontmatter.metadata,
      errorClass: "permanent",
    };
    await store.save(pre!);

    await transitionToDeadletter(
      store,
      logger,
      task.frontmatter.id,
      "Agent not found",
    );

    const after = await store.get(task.frontmatter.id);
    expect(after?.frontmatter.metadata.deadletterReason).toBe("permanent_error");
  });

  it("coordinator can cancel-with-reason from deadletter to clean up", async () => {
    const task = await store.create({
      title: "superseded candidate",
      body: "b",
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "blocked");
    await transitionToDeadletter(store, logger, task.frontmatter.id, "initial failure");

    // Coordinator decision: the work was actually completed via a direct
    // session fallback. Mark the task cancelled with a structured reason.
    const result = await store.cancel(
      task.frontmatter.id,
      "superseded: work completed via direct sessions_spawn run on 2026-04-23",
    );

    expect(result.frontmatter.status).toBe("cancelled");
    expect(result.frontmatter.metadata.cancellationReason).toMatch(/^superseded:/);
    // The deadletter evidence is preserved in metadata alongside the cancellation.
    expect(result.frontmatter.metadata.deadletterReason).toBe("max_dispatch_failures");
  });
});
