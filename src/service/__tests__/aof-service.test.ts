import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { MockNotificationAdapter } from "../../events/notifier.js";
import { NotificationPolicyEngine, DEFAULT_RULES } from "../../events/notification-policy/index.js";
import { AOFService } from "../aof-service.js";
import { AOFMetrics } from "../../metrics/exporter.js";
import { getMetricValue } from "../../testing/metrics-reader.js";
import type { PollResult } from "../../dispatch/scheduler.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("AOFService", () => {
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
    tmpDir = await mkdtemp(join(tmpdir(), "aof-service-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts and runs an initial poll", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    expect(poller).toHaveBeenCalledTimes(1);
    const status = service.getStatus();
    expect(status.running).toBe(true);
    expect(status.lastPollAt).toBeDefined();

    await service.stop();
  });

  it("triggers a poll on message events", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();
    await service.handleMessageReceived({ from: "swe-backend" });

    expect(poller).toHaveBeenCalledTimes(2);

    await service.stop();
  });

  it("does not poll after stop", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();
    await service.stop();
    await service.handleSessionEnd();

    expect(poller).toHaveBeenCalledTimes(1);
  });

  it("routes protocol messages before polling", async () => {
    const poller = vi.fn(async () => makePollResult());
    const protocolRouter = { route: vi.fn() };
    const service = new AOFService(
      { store, logger, poller, protocolRouter },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    await service.handleMessageReceived({
      payload: {
        protocol: "aof",
        version: 1,
        projectId: "test-project",
        type: "status.update",
        taskId: "TASK-2026-02-09-058",
        fromAgent: "swe-backend",
        toAgent: "swe-qa",
        sentAt: "2026-02-09T21:00:00.000Z",
        payload: {
          taskId: "TASK-2026-02-09-058",
          agentId: "swe-backend",
          status: "blocked",
          progress: "Waiting on API key",
          blockers: ["API key pending"],
          notes: "ETA tomorrow",
        },
      },
    });

    expect(protocolRouter.route).toHaveBeenCalledTimes(1);
    expect(poller).toHaveBeenCalledTimes(2);

    await service.stop();
  });

  it("sends startup notification via engine when engine is provided", async () => {
    const adapter = new MockNotificationAdapter();
    // Don't pass logger — let service create its own (wired to engine)
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const poller = vi.fn(async () => makePollResult());

    const service = new AOFService(
      { store, poller, engine },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // Engine should have routed the system.startup event
    expect(adapter.sent.length).toBeGreaterThan(0);
    const startupNotifications = adapter.sent.filter(n =>
      n.message.includes("started") || n.message.includes("AOF"),
    );
    expect(startupNotifications.length).toBeGreaterThan(0);

    await service.stop();
  });

  it("routes task transitions through engine via EventLogger", async () => {
    const adapter = new MockNotificationAdapter();
    // Don't pass logger — let service create its own (wired to engine)
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const poller = vi.fn(async () => makePollResult());

    // Don't pass store — let service create it with hooks
    const service = new AOFService(
      { poller, engine },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // Create a task and transition it via service's store
    const task = await service["store"].create({
      title: "Test notification task",
      priority: "normal",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });

    adapter.clear();

    await service["store"].transition(task.frontmatter.id, "ready", {
      agent: "swe-backend",
      reason: "Starting work",
    });

    // Engine should have routed task.transitioned through the adapter
    expect(adapter.sent.length).toBeGreaterThan(0);
    const transitionNotifications = adapter.sent.filter(n =>
      n.message.includes(task.frontmatter.id) ||
      n.message.includes("ready") ||
      n.message.includes("backlog"),
    );
    expect(transitionNotifications.length).toBeGreaterThan(0);

    await service.stop();
  });

  it("ODD: emits system.startup event to EventLogger on start", async () => {
    const capturedEvents: BaseEvent[] = [];
    const eventLogger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => capturedEvents.push(event),
    });
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger: eventLogger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // ODD: event log contains system.startup
    const startupEvent = capturedEvents.find(e => e.type === "system.startup");
    expect(startupEvent).toBeDefined();

    await service.stop();
  });

  it("ODD: events.jsonl written to filesystem after start", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // ODD: filesystem state — events.jsonl exists and contains startup event
    const eventsPath = join(tmpDir, "events", "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n").map(l => JSON.parse(l));
    expect(events.some((e: { type: string }) => e.type === "system.startup")).toBe(true);

    await service.stop();
  });

  it("ODD: aof_scheduler_poll_failures_total increments on poll error", async () => {
    const metrics = new AOFMetrics();
    const failingPoller = vi.fn(async (): Promise<PollResult> => {
      throw new Error("Simulated poll failure");
    });
    const service = new AOFService(
      { store, logger, poller: failingPoller, metrics },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // ODD: metric counter incremented after poll error
    const failures = await getMetricValue(metrics, "aof_scheduler_poll_failures_total");
    expect(failures).toBeGreaterThanOrEqual(1);

    await service.stop();
  });

  it("ODD: getStatus reflects poll results after start", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // ODD: observable state via getStatus — lastPollAt updated after poll
    const status = service.getStatus();
    expect(status.running).toBe(true);
    expect(status.lastPollAt).toBeDefined();
    expect(new Date(status.lastPollAt!).getTime()).toBeLessThanOrEqual(Date.now());

    await service.stop();

    // ODD: after stop, running is false
    expect(service.getStatus().running).toBe(false);
  });

  describe("Foundation Hardening (Phase 1)", () => {
    // --- FOUND-01: Timeout guard tests ---
    describe("poll timeout guard (FOUND-01)", () => {
      it("aborts a poll that exceeds pollTimeoutMs", async () => {
        // Poller that hangs forever (never resolves)
        const hangingPoller = vi.fn(
          () => new Promise<PollResult>(() => {/* never resolves */})
        );
        const service = new AOFService(
          { store, logger, poller: hangingPoller },
          { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true, pollTimeoutMs: 100 },
        );

        await service.start();

        // Wait for timeout to fire + some margin
        await new Promise(r => setTimeout(r, 300));

        // ODD: getStatus().lastError reflects the timeout
        const status = service.getStatus();
        expect(status.lastError).toContain("Poll timeout");
        // Service is still running (not crashed)
        expect(status.running).toBe(true);

        await service.stop();
      });

      it("proceeds to next poll after timeout", async () => {
        let callCount = 0;
        // First call hangs, second call succeeds
        const poller = vi.fn((): Promise<PollResult> => {
          callCount++;
          if (callCount === 1) {
            return new Promise(() => {/* never resolves */});
          }
          return Promise.resolve(makePollResult());
        });

        const service = new AOFService(
          { store, logger, poller },
          { dataDir: tmpDir, pollIntervalMs: 200, dryRun: true, pollTimeoutMs: 100 },
        );

        await service.start();

        // Wait for: first poll timeout (100ms) + interval (200ms) + second poll + margin
        await new Promise(r => setTimeout(r, 600));

        // ODD: poller was called at least twice (first timed out, second succeeded)
        expect(poller.mock.calls.length).toBeGreaterThanOrEqual(2);
        // ODD: after a successful poll, lastError should be cleared
        const status = service.getStatus();
        expect(status.lastError).toBeUndefined();

        await service.stop();
      });
    });

    // --- FOUND-02: Drain tests ---
    describe("graceful drain (FOUND-02)", () => {
      it("stop() waits for in-flight poll to complete", async () => {
        // Poller that takes 500ms to complete
        const slowPoller = vi.fn(
          () => new Promise<PollResult>(resolve =>
            setTimeout(() => resolve(makePollResult()), 500)
          )
        );

        const service = new AOFService(
          { store, logger, poller: slowPoller },
          { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
        );

        await service.start();

        // Trigger a poll and immediately stop
        const pollPromise = service["triggerPoll"]("test");
        const stopStart = Date.now();
        // Await pollPromise in parallel with stop so we don't deadlock
        const [, ] = await Promise.all([pollPromise, service.stop()]);
        const stopDuration = Date.now() - stopStart;

        // ODD: stop() should have waited for the slow poll (~500ms), not returned instantly
        expect(stopDuration).toBeGreaterThanOrEqual(300);
      });

      it("stop() force-exits after drain timeout", async () => {
        // Poller that hangs forever but resolves a gate so we know it started
        let pollStarted: () => void;
        const pollStartedPromise = new Promise<void>(r => { pollStarted = r; });
        const hangingPoller = vi.fn(
          () => {
            pollStarted!();
            return new Promise<PollResult>(() => {/* never resolves */});
          }
        );

        const service = new AOFService(
          { store, logger, poller: hangingPoller },
          // Poll timeout must be longer than drain timeout so the poll is
          // still "in-flight" when drain fires. 60s poll timeout >> 10s drain.
          { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true, pollTimeoutMs: 60_000 },
        );

        // Don't await start() -- it blocks until triggerPoll("startup") completes,
        // which includes runPoll(). Since the poller hangs and poll timeout is 60s,
        // start() would block for 60s. Instead, fire-and-forget and wait for the
        // poller to actually start.
        void service.start();
        await pollStartedPromise;

        // The startup poll is now in-flight and hanging. Call stop().
        // Drain timeout is 10s. We'll verify stop() completes.
        const stopStart = Date.now();
        await service.stop();
        const stopDuration = Date.now() - stopStart;

        // ODD: stop() should complete after drain timeout (~10s), not hang forever
        // Using generous bounds to account for CI variability
        expect(stopDuration).toBeGreaterThanOrEqual(9_000);
        expect(stopDuration).toBeLessThan(15_000);
      }, 20_000);

      it("stop() returns quickly when no poll in flight", async () => {
        const poller = vi.fn(async () => makePollResult());
        const service = new AOFService(
          { store, logger, poller },
          { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
        );

        await service.start();
        // Wait for startup poll to finish
        await new Promise(r => setTimeout(r, 50));

        const stopStart = Date.now();
        await service.stop();
        const stopDuration = Date.now() - stopStart;

        // ODD: stop() should return quickly (<500ms) when no poll is in-flight
        expect(stopDuration).toBeLessThan(500);
      });
    });

    // --- FOUND-03: Reconciliation tests ---
    describe("startup orphan reconciliation (FOUND-03)", () => {
      it("reclaims in-progress tasks on startup", async () => {
        // Create a task and manually transition it to in-progress
        const task = await store.create({
          title: "Orphaned task",
          priority: "normal",
          routing: { agent: "swe-backend" },
          createdBy: "test",
        });
        await store.transition(task.frontmatter.id, "ready");
        await store.transition(task.frontmatter.id, "in-progress", {
          agent: "swe-backend",
        });

        // Verify it's in-progress
        const before = await store.get(task.frontmatter.id);
        expect(before?.frontmatter.status).toBe("in-progress");

        // Start a new service (simulates daemon restart)
        const poller = vi.fn(async () => makePollResult());
        const service = new AOFService(
          { store, logger, poller },
          { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
        );
        await service.start();

        // ODD: task should now be "ready" (reclaimed)
        const after = await store.get(task.frontmatter.id);
        expect(after?.frontmatter.status).toBe("ready");

        await service.stop();
      });

      it("logs each reclaimed task individually", async () => {
        const infoSpy = vi.spyOn(console, "info");

        // Create 2 in-progress tasks
        const task1 = await store.create({
          title: "Orphan 1",
          priority: "normal",
          routing: { agent: "agent-a" },
          createdBy: "test",
        });
        await store.transition(task1.frontmatter.id, "ready");
        await store.transition(task1.frontmatter.id, "in-progress", { agent: "agent-a" });

        const task2 = await store.create({
          title: "Orphan 2",
          priority: "normal",
          routing: { agent: "agent-b" },
          createdBy: "test",
        });
        await store.transition(task2.frontmatter.id, "ready");
        await store.transition(task2.frontmatter.id, "in-progress", { agent: "agent-b" });

        const poller = vi.fn(async () => makePollResult());
        const service = new AOFService(
          { store, logger, poller },
          { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
        );
        await service.start();

        // ODD: console.info called with each task ID
        const reclaimLogs = infoSpy.mock.calls
          .map(c => c[0] as string)
          .filter(msg => msg.includes("Reclaimed orphaned task"));
        expect(reclaimLogs.length).toBe(2);
        expect(reclaimLogs.some(l => l.includes(task1.frontmatter.id))).toBe(true);
        expect(reclaimLogs.some(l => l.includes(task2.frontmatter.id))).toBe(true);

        // ODD: summary line logged
        const summaryLogs = infoSpy.mock.calls
          .map(c => c[0] as string)
          .filter(msg => msg.includes("2 task(s) reclaimed"));
        expect(summaryLogs.length).toBe(1);

        infoSpy.mockRestore();
        await service.stop();
      });

      it("handles startup with no orphaned tasks", async () => {
        const infoSpy = vi.spyOn(console, "info");

        // Create a task in backlog (not in-progress)
        await store.create({
          title: "Normal task",
          priority: "normal",
          createdBy: "test",
        });

        const poller = vi.fn(async () => makePollResult());
        const service = new AOFService(
          { store, logger, poller },
          { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
        );
        await service.start();

        // ODD: no reclaim logs, only "no orphaned tasks" summary
        const reclaimLogs = infoSpy.mock.calls
          .map(c => c[0] as string)
          .filter(msg => msg.includes("Reclaimed orphaned task"));
        expect(reclaimLogs.length).toBe(0);

        const noOrphanLogs = infoSpy.mock.calls
          .map(c => c[0] as string)
          .filter(msg => msg.includes("no orphaned tasks found"));
        expect(noOrphanLogs.length).toBe(1);

        infoSpy.mockRestore();
        await service.stop();
      });
    });
  });
});
