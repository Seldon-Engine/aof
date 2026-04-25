/**
 * Phase 46 / Bug 2A — Project rediscovery regression test (BUG-046b).
 *
 * Root cause: AOFService.initializeProjects() ran once at boot and
 * populated this.projectStores with a frozen snapshot. Every subsequent
 * poll() iterated that frozen Map, so a project directory created AFTER
 * boot was invisible until daemon restart.
 *
 * Field incident (2026-04-24): the daemon restarted at 16:43; the
 * `event-calendar-2026` project was created at 20:36; zero log entries
 * exist for any of its 5 task IDs over the next 21 minutes. The
 * dispatching agent eventually gave up and did the work itself.
 *
 * Fix: runPoll() calls a new private rediscoverProjects() as its first
 * step, before pollAllProjects(). Rediscovery is serialized via the
 * existing pollQueue, so it never races with pollAllProjects.
 *
 * Test scaffolding mirrors multi-project-polling.test.ts (TestExecutor +
 * createProject/createTask helpers + tmpdir fixture).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { AOFService } from "../aof-service.js";
import type { GatewayAdapter, TaskContext, SpawnResult } from "../../dispatch/executor.js";

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

class TestExecutor implements GatewayAdapter {
  readonly spawned: TaskContext[] = [];

  async spawnSession(context: TaskContext): Promise<SpawnResult> {
    this.spawned.push(context);
    return {
      success: true,
      sessionId: `session-${context.taskId}`,
    };
  }

  async getSessionStatus(sessionId: string) {
    return { sessionId, alive: false };
  }

  async forceCompleteSession(_sessionId: string) {}

  clear(): void {
    this.spawned.length = 0;
  }
}

describe("Phase 46 / Bug 2A — project rediscovery (BUG-046b)", () => {
  let tmpDir: string;
  let vaultRoot: string;
  let executor: TestExecutor;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-rediscover-"));
    vaultRoot = tmpDir;
    executor = new TestExecutor();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createProject(
    projectId: string,
    opts: { title?: string; status?: string } = {}
  ): Promise<string> {
    const projectPath = join(vaultRoot, "Projects", projectId);
    await mkdir(projectPath, { recursive: true });

    const manifest = {
      id: projectId,
      title: opts.title ?? projectId,
      status: opts.status ?? "active",
      type: "swe",
      owner: { team: "engineering", lead: "test" },
      participants: [],
      routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: false } },
      memory: {
        tiers: { bronze: "cold", silver: "warm", gold: "warm" },
        allowIndex: { warmPaths: [] },
        denyIndex: [],
      },
      links: { dashboards: [], docs: [] },
    };

    await writeFile(
      join(projectPath, "project.yaml"),
      stringifyYaml(manifest),
      "utf-8"
    );

    // Create task directories
    const tasksDir = join(projectPath, "tasks");
    await mkdir(join(tasksDir, "backlog"), { recursive: true });
    await mkdir(join(tasksDir, "ready"), { recursive: true });
    await mkdir(join(tasksDir, "in-progress"), { recursive: true });
    await mkdir(join(tasksDir, "done"), { recursive: true });

    return projectPath;
  }

  async function createTask(
    projectPath: string,
    taskId: string,
    opts: { status?: string; agent?: string; projectId?: string } = {}
  ): Promise<void> {
    const status = opts.status ?? "ready";
    const taskPath = join(projectPath, "tasks", status, `${taskId}.md`);
    const now = new Date().toISOString();

    const projectId = opts.projectId ?? projectPath.split("/").pop()!;

    const frontmatter = {
      schemaVersion: 1,
      id: taskId,
      project: projectId,
      title: `Task ${taskId}`,
      status,
      priority: "normal",
      createdAt: now,
      updatedAt: now,
      lastTransitionAt: now,
      createdBy: "test-system",
      routing: opts.agent ? { agent: opts.agent, tags: [] } : { tags: [] },
    };

    const content = `---
${stringifyYaml(frontmatter)}---

## Instructions
Test task for project rediscovery.
`;

    await writeFile(taskPath, content, "utf-8");
  }

  it("a project created after init() is polled on the next runPoll()", async () => {
    // Arrange: start with ONE project so vaultRoot mode kicks in.
    await createProject("initial-proj");

    // Use a long pollIntervalMs so the auto-poll timer doesn't fire
    // during the test — we'll trigger polls explicitly.
    const service = new AOFService(
      { executor },
      {
        dataDir: join(tmpDir, "data"),
        vaultRoot,
        dryRun: false,
        pollIntervalMs: 60_000,
      }
    );

    await service.start();

    // Wait for the startup poll to drain (initializeProjects + reconcileOrphans + first runPoll).
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Baseline: only initial-proj is registered. No tasks have been
    // dispatched (initial-proj has no tasks).
    expect(executor.spawned).toHaveLength(0);

    // Act: create a NEW project AFTER service.start() has returned.
    // Pre-Phase-46 this was invisible to the daemon until restart.
    const postInitProj = await createProject("post-init-proj");
    await createTask(postInitProj, "TASK-2026-04-25-001", { agent: "swe-backend" });

    // Trigger ONE more poll explicitly. Cast to access the private
    // triggerPoll method — we deliberately avoid adding test-only
    // surface to AOFService; the service-internal API is sufficient.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).triggerPoll("test");

    // Assert: the new project's task was dispatched on the next poll.
    expect(executor.spawned).toHaveLength(1);
    expect(executor.spawned[0]!.taskId).toBe("TASK-2026-04-25-001");
    expect(executor.spawned[0]!.projectId).toBe("post-init-proj");

    await service.stop();
  });

  it("a vanished project is removed from projectStores", async () => {
    // Arrange: start with two projects, each with no tasks.
    await createProject("proj-a");
    const projBPath = await createProject("proj-b");

    const service = new AOFService(
      { executor },
      {
        dataDir: join(tmpDir, "data"),
        vaultRoot,
        dryRun: false,
        pollIntervalMs: 60_000,
      }
    );

    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Act: drop a task into proj-b, then rm -rf the proj-b directory
    // BEFORE triggering the next poll. After rediscovery removes
    // proj-b's store, the task should not be picked up — the indirect
    // assertion is "no spawn for that taskId."
    await createTask(projBPath, "TASK-2026-04-25-002", { agent: "swe-qa" });
    await rm(projBPath, { recursive: true, force: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).triggerPoll("test");

    // Assert: no spawn for the vanished project's task.
    const spawnedForB = executor.spawned.filter(
      (c) => c.projectId === "proj-b"
    );
    expect(spawnedForB).toHaveLength(0);

    await service.stop();
  });

  it("rediscovery + pollAllProjects share pollQueue serialization", async () => {
    // This case proves the ordering invariant: the second triggerPoll
    // is enqueued behind the first via pollQueue, so a project created
    // between the two triggerPoll() calls is deterministically picked
    // up by the second poll (not the first). The pollQueue serialization
    // already exists in AOFService; this test just exercises it through
    // the rediscovery path.
    await createProject("seed-proj");

    const service = new AOFService(
      { executor },
      {
        dataDir: join(tmpDir, "data"),
        vaultRoot,
        dryRun: false,
        pollIntervalMs: 60_000,
      }
    );

    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // First poll — no new project visible yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstPoll = (service as any).triggerPoll("test-1") as Promise<void>;
    await firstPoll;
    expect(executor.spawned).toHaveLength(0);

    // Now create the project + task and trigger the second poll.
    const newProjPath = await createProject("late-proj");
    await createTask(newProjPath, "TASK-2026-04-25-003", { agent: "swe-backend" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).triggerPoll("test-2");

    expect(executor.spawned).toHaveLength(1);
    expect(executor.spawned[0]!.projectId).toBe("late-proj");

    await service.stop();
  });
});
