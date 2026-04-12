import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { OpenClawTaskRecipientNotifier } from "../task-recipient-notifier.js";
import { MockMatrixMessageTool } from "../matrix-notifier.js";
import { writeRunResult } from "../../recovery/run-artifacts.js";

describe("OpenClawTaskRecipientNotifier", () => {
  it("routes terminal task updates back to the captured reply target", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "aof-task-recipient-"));
    const store = new FilesystemTaskStore(projectRoot);
    await store.init();

    const task = await store.create({
      title: "Worker task",
      body: "Complete the task",
      createdBy: "main",
      metadata: {
        notificationRecipient: {
          kind: "openclaw-session",
          sessionKey: "agent:main:telegram:group:42",
          replyTarget: "telegram:-10042",
          channel: "telegram",
          capturedAt: new Date().toISOString(),
        },
      },
    });

    await writeRunResult(store, task.frontmatter.id, {
      taskId: task.frontmatter.id,
      agentId: "swe-backend",
      completedAt: new Date().toISOString(),
      outcome: "done",
      summaryRef: "outputs/summary.md",
      handoffRef: "outputs/handoff.md",
      deliverables: [],
      tests: { total: 1, passed: 1, failed: 0 },
      blockers: [],
      notes: "All acceptance criteria are complete.",
    });

    const messageTool = new MockMatrixMessageTool();
    const notifier = new OpenClawTaskRecipientNotifier(
      async (taskId) => (taskId === task.frontmatter.id ? store : undefined),
      messageTool,
    );

    await notifier.handleEvent({
      eventId: 1,
      type: "task.transitioned",
      timestamp: new Date().toISOString(),
      actor: "swe-backend",
      taskId: task.frontmatter.id,
      payload: {
        from: "review",
        to: "done",
        reason: "task_complete",
      },
    });

    expect(messageTool.sent).toHaveLength(1);
    expect(messageTool.sent[0]).toMatchObject({
      target: "telegram:-10042",
    });
    expect(messageTool.sent[0]?.message).toContain("Task complete");
    expect(messageTool.sent[0]?.message).toContain(task.frontmatter.id);
    expect(messageTool.sent[0]?.message).toContain("outputs/summary.md");
  });

  it("deduplicates repeated notifications for the same task/status/target tuple", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "aof-task-recipient-dedupe-"));
    const store = new FilesystemTaskStore(projectRoot);
    await store.init();

    const task = await store.create({
      title: "Worker task",
      body: "Complete the task",
      createdBy: "main",
      metadata: {
        notificationRecipient: {
          kind: "openclaw-session",
          replyTarget: "telegram:-10042",
          capturedAt: new Date().toISOString(),
        },
      },
    });

    const messageTool = new MockMatrixMessageTool();
    const notifier = new OpenClawTaskRecipientNotifier(async () => store, messageTool);
    const event = {
      eventId: 1,
      type: "task.transitioned" as const,
      timestamp: new Date().toISOString(),
      actor: "swe-backend",
      taskId: task.frontmatter.id,
      payload: {
        from: "in-progress",
        to: "review",
      },
    };

    await notifier.handleEvent(event);
    await notifier.handleEvent({ ...event, eventId: 2 });

    expect(messageTool.sent).toHaveLength(1);
  });
});
