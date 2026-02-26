/**
 * Gateway dispatch integration tests — validates correlation ID propagation,
 * adapter-mediated session lifecycle, and spawn failure classification.
 *
 * Three mandatory scenarios (GATE-03, GATE-04, GATE-05):
 * 1. Dispatch-to-completion success with correlation ID verification
 * 2. Heartbeat timeout triggers forceCompleteSession and task reclaim
 * 3. Spawn failure classified correctly per Phase 1 taxonomy
 *
 * Uses MockAdapter for fast, deterministic testing (no real gateway).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { MockAdapter } from "../../src/dispatch/executor.js";
import { poll, resetThrottleState } from "../../src/dispatch/scheduler.js";
import { EventLogger } from "../../src/events/logger.js";
import { FilesystemTaskStore } from "../../src/store/task-store.js";
import type { ITaskStore } from "../../src/store/interfaces.js";
import type { SchedulerConfig } from "../../src/dispatch/scheduler.js";
import { writeHeartbeat } from "../../src/recovery/run-artifacts.js";

// UUID v4 pattern: 8-4-4-4-12 hex digits
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("Gateway dispatch integration", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let adapter: MockAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-gateway-dispatch-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);

    adapter = new MockAdapter();

    // Reset module-level throttle state between tests
    resetThrottleState();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
    return {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      maxConcurrentDispatches: 10,
      minDispatchIntervalMs: 0,
      maxDispatchesPerPoll: 10,
      executor: adapter,
      ...overrides,
    };
  }

  // =========================================================================
  // Scenario 1: Dispatch-to-completion success (GATE-03 + GATE-05)
  // =========================================================================

  describe("Scenario 1: dispatch-to-completion success", () => {
    it("dispatches task with correlationId in metadata, spawnSession args, and event logs", async () => {
      // 1. Create a task in "ready" status with an agent assigned
      const task = await store.create({
        title: "Correlation ID test task",
        createdBy: "ci",
        routing: { agent: "test-agent" },
        metadata: { reviewRequired: false },
      });
      await store.transition(task.frontmatter.id, "ready");

      // 2. Run poll with adapter (autoComplete enabled by default)
      const result = await poll(store, logger, makeConfig());

      // 3. Assert: an "assign" action was produced
      const assignActions = result.actions.filter(a => a.type === "assign");
      expect(assignActions).toHaveLength(1);
      expect(assignActions[0]!.taskId).toBe(task.frontmatter.id);

      // 4. Assert: task metadata now contains correlationId (UUID v4 format)
      const updated = await store.get(task.frontmatter.id);
      expect(updated).toBeDefined();
      const correlationId = updated!.frontmatter.metadata?.correlationId as string;
      expect(correlationId).toBeDefined();
      expect(correlationId).toMatch(UUID_V4_RE);

      // 5. Assert: task metadata contains sessionId
      const sessionId = updated!.frontmatter.metadata?.sessionId as string;
      expect(sessionId).toBeDefined();
      expect(sessionId).toContain("mock-session-");

      // 6. Assert: adapter.spawned has one entry with matching correlationId
      expect(adapter.spawned).toHaveLength(1);
      expect(adapter.spawned[0]!.opts?.correlationId).toBe(correlationId);

      // 7. Assert: dispatch event in events.jsonl contains correlationId
      const events = await logger.query({ type: "dispatch.matched" });
      expect(events.length).toBeGreaterThanOrEqual(1);
      const dispatchEvent = events.find(e => e.taskId === task.frontmatter.id);
      expect(dispatchEvent).toBeDefined();
      expect(dispatchEvent!.payload).toHaveProperty("correlationId", correlationId);
    });
  });

  // =========================================================================
  // Scenario 2: Heartbeat timeout triggers force-complete and task reclaim
  // (GATE-04 + GATE-05)
  // =========================================================================

  describe("Scenario 2: heartbeat timeout with force-complete", () => {
    it("force-completes session and reclaims task when heartbeat expires", async () => {
      // 1. Create a task in "ready" status with an agent assigned
      const task = await store.create({
        title: "Heartbeat timeout test task",
        createdBy: "ci",
        routing: { agent: "test-agent" },
        metadata: { reviewRequired: false },
      });
      await store.transition(task.frontmatter.id, "ready");

      // 2. Create MockAdapter with autoComplete DISABLED
      adapter.setAutoComplete(false);

      // 3. Run poll() to dispatch the task (moves to in-progress)
      const poll1 = await poll(store, logger, makeConfig());

      const assignActions = poll1.actions.filter(a => a.type === "assign");
      expect(assignActions).toHaveLength(1);

      // 4. Assert: task is now in-progress with sessionId in metadata
      const dispatched = await store.get(task.frontmatter.id);
      expect(dispatched).toBeDefined();
      expect(dispatched!.frontmatter.status).toBe("in-progress");
      const sessionId = dispatched!.frontmatter.metadata?.sessionId as string;
      expect(sessionId).toBeDefined();
      const correlationId = dispatched!.frontmatter.metadata?.correlationId as string;
      expect(correlationId).toBeDefined();

      // 5. Mark session as stale in the adapter
      adapter.setSessionStale(sessionId);

      // 6. Write an expired heartbeat file for the task (expiresAt in the past)
      // Use a TTL of 1ms so expiresAt is already past by the time we check
      await writeHeartbeat(store, task.frontmatter.id, "test-agent", 1);
      // Wait briefly to ensure the heartbeat is expired
      await new Promise(r => setTimeout(r, 10));

      // 7. Run poll() again — should detect stale heartbeat
      resetThrottleState();
      const poll2 = await poll(store, logger, makeConfig({
        heartbeatTtlMs: 1, // Very short TTL to trigger detection
      }));

      // 8. Assert: a "stale_heartbeat" action was produced
      const staleActions = poll2.actions.filter(a => a.type === "stale_heartbeat");
      expect(staleActions).toHaveLength(1);
      expect(staleActions[0]!.taskId).toBe(task.frontmatter.id);

      // 9. Assert: task has been reclaimed (transitioned back to ready since no run_result)
      const reclaimed = await store.get(task.frontmatter.id);
      expect(reclaimed).toBeDefined();
      expect(reclaimed!.frontmatter.status).toBe("ready");

      // 10. Assert: event log contains session.force_completed event with correlationId
      const forceCompleteEvents = await logger.query({ type: "session.force_completed" });
      expect(forceCompleteEvents.length).toBeGreaterThanOrEqual(1);
      const fcEvent = forceCompleteEvents.find(e => e.taskId === task.frontmatter.id);
      expect(fcEvent).toBeDefined();
      expect(fcEvent!.payload).toHaveProperty("sessionId", sessionId);
      expect(fcEvent!.payload).toHaveProperty("correlationId", correlationId);
      expect(fcEvent!.payload).toHaveProperty("reason", "stale_heartbeat");
    });
  });

  // =========================================================================
  // Scenario 3: Spawn failure is classified correctly per Phase 1 taxonomy
  // (GATE-05)
  // =========================================================================

  describe("Scenario 3: spawn failure classification", () => {
    it("classifies rate-limited errors as blocked and permanent errors as deadletter", async () => {
      // --- Part A: rate_limited -> blocked ---

      // 1. Create a task in "ready" status with an agent assigned
      const taskA = await store.create({
        title: "Rate-limited failure test",
        createdBy: "ci",
        routing: { agent: "test-agent" },
        metadata: { reviewRequired: false },
      });
      await store.transition(taskA.frontmatter.id, "ready");

      // 2. Configure adapter to fail with rate-limit error
      adapter.setShouldFail(true, "429 Too Many Requests");

      // 3. Run poll()
      const poll1 = await poll(store, logger, makeConfig());

      // 4. Assert: an "assign" action was produced but dispatch failed
      const assignActionsA = poll1.actions.filter(a => a.type === "assign");
      expect(assignActionsA).toHaveLength(1);

      // 5. Assert: task transitioned to "blocked" (rate_limited is transient, goes to blocked)
      const blockedTask = await store.get(taskA.frontmatter.id);
      expect(blockedTask).toBeDefined();
      expect(blockedTask!.frontmatter.status).toBe("blocked");

      // 6. Assert: task metadata contains errorClass: "rate_limited"
      expect(blockedTask!.frontmatter.metadata?.errorClass).toBe("rate_limited");

      // 7. Assert: dispatch.error event logged
      const errorEventsA = await logger.query({ type: "dispatch.error" });
      const taskAError = errorEventsA.find(e => e.taskId === taskA.frontmatter.id);
      expect(taskAError).toBeDefined();

      // --- Part B: permanent -> deadletter ---

      // 8. Reset adapter for permanent error
      adapter.setShouldFail(true, "no such agent: nonexistent");

      // 9. Create another ready task
      const taskB = await store.create({
        title: "Permanent failure test",
        createdBy: "ci",
        routing: { agent: "nonexistent" },
        metadata: { reviewRequired: false },
      });
      await store.transition(taskB.frontmatter.id, "ready");

      // 10. Run poll() again
      resetThrottleState();
      const poll2 = await poll(store, logger, makeConfig());

      // 11. Assert: task transitioned to "deadletter" (permanent error)
      const deadletteredTask = await store.get(taskB.frontmatter.id);
      expect(deadletteredTask).toBeDefined();
      expect(deadletteredTask!.frontmatter.status).toBe("deadletter");
    });
  });
});
