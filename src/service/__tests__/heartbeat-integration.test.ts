import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestHarness, type TestHarness } from "../../testing/index.js";
import { acquireLease } from "../../store/lease.js";
import { AOFService } from "../aof-service.js";
import { poll } from "../../dispatch/scheduler.js";
import { writeRunResult, readRunArtifact } from "../../recovery/run-artifacts.js";
import type { RunResult } from "../../schemas/run-result.js";

// Mock structured logger to suppress output during tests
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));

describe("heartbeat integration", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness("aof-heartbeat-test");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("stale heartbeat with no run_result requeues to ready and marks artifact expired", async () => {
    const task = await harness.store.create({
      title: "Stale task without result",
      createdBy: "main",
      routing: { agent: "test-agent" },
    });
    await harness.store.transition(task.frontmatter.id, "ready");

    // Acquire lease with 1ms heartbeat TTL
    await acquireLease(harness.store, task.frontmatter.id, "test-agent", {
      heartbeatTtlMs: 1,
    });

    // Wait for heartbeat to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run scheduler poll (active mode)
    const result = await poll(harness.store, harness.logger, {
      dataDir: harness.tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      heartbeatTtlMs: 1,
    });

    // Should detect stale heartbeat
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe("stale_heartbeat");

    // Task should be requeued to ready (no run_result)
    const updated = await harness.store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("ready");

    // Run artifact should be marked expired
    const runArtifact = await readRunArtifact(harness.store, task.frontmatter.id);
    expect(runArtifact?.status).toBe("failed");
    expect(runArtifact?.metadata?.expiredAt).toBeDefined();
  });

  it("stale heartbeat with partial outcome moves to review", async () => {
    const task = await harness.store.create({
      title: "Stale task with partial",
      createdBy: "main",
      routing: { agent: "test-agent" },
    });
    await harness.store.transition(task.frontmatter.id, "ready");

    // Acquire lease with 1ms heartbeat TTL
    await acquireLease(harness.store, task.frontmatter.id, "test-agent", {
      heartbeatTtlMs: 1,
    });

    // Write run_result.json with partial outcome
    const runResult: RunResult = {
      taskId: task.frontmatter.id,
      agentId: "test-agent",
      outcome: "partial",
      completedAt: new Date().toISOString(),
      summaryRef: "summary.md",
      handoffRef: "handoff.md",
      tests: { total: 3, passed: 2, failed: 1 },
      notes: "Partial completion",
    };
    await writeRunResult(harness.store, task.frontmatter.id, runResult);

    // Wait for heartbeat to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run scheduler poll
    const result = await poll(harness.store, harness.logger, {
      dataDir: harness.tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      heartbeatTtlMs: 1,
    });

    // Should detect stale heartbeat
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe("stale_heartbeat");

    // Task should be moved to review
    const updated = await harness.store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("review");
  });

  it("stale heartbeat with needs_review outcome moves to review", async () => {
    const task = await harness.store.create({
      title: "Stale task with needs_review",
      createdBy: "main",
      routing: { agent: "test-agent" },
    });
    await harness.store.transition(task.frontmatter.id, "ready");

    // Acquire lease with 1ms heartbeat TTL
    await acquireLease(harness.store, task.frontmatter.id, "test-agent", {
      heartbeatTtlMs: 1,
    });

    // Write run_result.json with needs_review outcome
    const runResult: RunResult = {
      taskId: task.frontmatter.id,
      agentId: "test-agent",
      outcome: "needs_review",
      completedAt: new Date().toISOString(),
      summaryRef: "summary.md",
      handoffRef: "handoff.md",
      tests: { total: 5, passed: 5, failed: 0 },
      notes: "Needs review",
    };
    await writeRunResult(harness.store, task.frontmatter.id, runResult);

    // Wait for heartbeat to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run scheduler poll
    const result = await poll(harness.store, harness.logger, {
      dataDir: harness.tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      heartbeatTtlMs: 1,
    });

    // Should detect stale heartbeat
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe("stale_heartbeat");

    // Task should be moved to review
    const updated = await harness.store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("review");
  });

  it("stale heartbeat with blocked outcome moves to blocked", async () => {
    const task = await harness.store.create({
      title: "Stale task with blocked",
      createdBy: "main",
      routing: { agent: "test-agent" },
    });
    await harness.store.transition(task.frontmatter.id, "ready");

    // Acquire lease with 1ms heartbeat TTL
    await acquireLease(harness.store, task.frontmatter.id, "test-agent", {
      heartbeatTtlMs: 1,
    });

    // Write run_result.json with blocked outcome
    const runResult: RunResult = {
      taskId: task.frontmatter.id,
      agentId: "test-agent",
      outcome: "blocked",
      completedAt: new Date().toISOString(),
      summaryRef: "summary.md",
      handoffRef: "handoff.md",
      tests: { total: 0, passed: 0, failed: 0 },
      blockers: ["Dependency not ready"],
      notes: "Blocked on dependency",
    };
    await writeRunResult(harness.store, task.frontmatter.id, runResult);

    // Wait for heartbeat to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run scheduler poll
    const result = await poll(harness.store, harness.logger, {
      dataDir: harness.tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      heartbeatTtlMs: 1,
    });

    // Should detect stale heartbeat
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe("stale_heartbeat");

    // Task should be moved to blocked
    const updated = await harness.store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("blocked");
  });

  it("stale heartbeat with done outcome moves to review then done", async () => {
    const task = await harness.store.create({
      title: "Stale task with done",
      createdBy: "main",
      routing: { agent: "test-agent" },
      metadata: { reviewRequired: false }, // Skip review step
    });
    await harness.store.transition(task.frontmatter.id, "ready");

    // Acquire lease with 1ms heartbeat TTL
    await acquireLease(harness.store, task.frontmatter.id, "test-agent", {
      heartbeatTtlMs: 1,
    });

    // Write run_result.json with done outcome
    const runResult: RunResult = {
      taskId: task.frontmatter.id,
      agentId: "test-agent",
      outcome: "done",
      completedAt: new Date().toISOString(),
      summaryRef: "summary.md",
      handoffRef: "handoff.md",
      tests: { total: 5, passed: 5, failed: 0 },
      notes: "Task completed successfully",
    };
    await writeRunResult(harness.store, task.frontmatter.id, runResult);

    // Wait for heartbeat to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run scheduler poll
    const result = await poll(harness.store, harness.logger, {
      dataDir: harness.tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      heartbeatTtlMs: 1,
    });

    // Should detect stale heartbeat
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe("stale_heartbeat");

    // Task should be moved to done (two transitions: review -> done)
    const updated = await harness.store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("done");
  });

  it("session_end triggers immediate poll", async () => {
    const poller = vi.fn(async () => ({
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
    }));

    const service = new AOFService(
      { store: harness.store, logger: harness.logger, poller },
      { dataDir: harness.tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();
    expect(poller).toHaveBeenCalledTimes(1);

    // Trigger session_end
    await service.handleSessionEnd({ sessionId: "test" });

    // Should trigger additional poll
    expect(poller).toHaveBeenCalledTimes(2);

    await service.stop();
  });

  it("does not flag tasks with fresh heartbeats", async () => {
    const task = await harness.store.create({
      title: "Fresh task",
      createdBy: "main",
      routing: { agent: "test-agent" },
    });
    await harness.store.transition(task.frontmatter.id, "ready");

    // Acquire lease with 5min heartbeat TTL
    await acquireLease(harness.store, task.frontmatter.id, "test-agent", {
      heartbeatTtlMs: 300_000,
    });

    // Run scheduler poll
    const result = await poll(harness.store, harness.logger, {
      dataDir: harness.tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      heartbeatTtlMs: 300_000,
    });

    // Should not detect stale heartbeat
    const staleActions = result.actions.filter(a => a.type === "stale_heartbeat");
    expect(staleActions).toHaveLength(0);

    // Task should remain in-progress
    const updated = await harness.store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("in-progress");
  });
});
