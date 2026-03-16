/**
 * ODD Integration Tests: Prometheus metric emission (AOF-honeycomb-005)
 *
 * Verifies that observable telemetry surfaces emit correctly:
 *   1. Poll duration histogram increments via AOFService
 *   2. Poll failure counter increments on poller error
 *   3. aof_tasks_total gauge reflects real store state via collectMetrics
 *   4. Per-agent task gauge labelled correctly
 *   5. schedulerUp gauge toggled correctly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestHarness, type TestHarness, getMetricValue } from "../../testing/index.js";
import { AOFMetrics } from "../../metrics/exporter.js";
import { AOFService } from "../../service/aof-service.js";
import { collectMetrics } from "../../metrics/collector.js";
import { acquireLease } from "../../store/lease.js";

describe("Metrics emission (AOF-honeycomb-005)", () => {
  let harness: TestHarness;
  let metrics: AOFMetrics;

  beforeEach(async () => {
    harness = await createTestHarness("aof-metrics-emission");
    metrics = new AOFMetrics();
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.restoreAllMocks();
  });

  it("poll duration histogram increments after each scheduler poll", async () => {
    const before =
      (await getMetricValue(metrics, "aof_scheduler_loop_duration_seconds_count")) ?? 0;

    const service = new AOFService(
      { store: harness.store, logger: harness.logger, metrics },
      { dataDir: harness.tmpDir, dryRun: true, pollIntervalMs: 60_000 },
    );
    await service.start();
    await service.stop();

    const after =
      (await getMetricValue(metrics, "aof_scheduler_loop_duration_seconds_count")) ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("poll failure counter increments when poller throws", async () => {
    const before =
      (await getMetricValue(metrics, "aof_scheduler_poll_failures_total")) ?? 0;

    const failingPoller = vi.fn().mockRejectedValue(new Error("simulated poll failure"));
    const service = new AOFService(
      { store: harness.store, logger: harness.logger, metrics, poller: failingPoller },
      { dataDir: harness.tmpDir, dryRun: false, pollIntervalMs: 60_000 },
    );
    await service.start();
    await service.stop();

    const after =
      (await getMetricValue(metrics, "aof_scheduler_poll_failures_total")) ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("aof_tasks_total gauge reflects task state after collectMetrics + updateFromState", async () => {
    const task = await harness.store.create({
      title: "Ready Task",
      routing: { agent: "swe-qa" },
      createdBy: "test",
    });
    await harness.store.transition(task.frontmatter.id, "ready");

    const state = await collectMetrics(harness.store);
    metrics.updateFromState(state);

    const count = await getMetricValue(metrics, "aof_tasks_total", {
      state: "ready",
      agent: "all",
    });
    expect(count).toBe(1);
  });

  it("per-agent task gauge labelled correctly after dispatch", async () => {
    const task = await harness.store.create({
      title: "In-Progress Task",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await harness.store.transition(task.frontmatter.id, "ready");
    await acquireLease(harness.store, task.frontmatter.id, "swe-backend");

    const state = await collectMetrics(harness.store);
    metrics.updateFromState(state);

    const perAgent = await getMetricValue(metrics, "aof_tasks_total", {
      state: "in-progress",
      agent: "swe-backend",
    });
    expect(perAgent).toBe(1);

    // Aggregate agent="all" also counts it
    const aggregate = await getMetricValue(metrics, "aof_tasks_total", {
      state: "in-progress",
      agent: "all",
    });
    expect(aggregate).toBe(1);
  });

  it("aof_scheduler_up gauge toggles between 1 and 0", async () => {
    metrics.updateFromState({
      tasksByStatus: {},
      tasksByAgentAndStatus: [],
      staleTasks: [],
      schedulerUp: true,
    });
    expect(await getMetricValue(metrics, "aof_scheduler_up")).toBe(1);

    metrics.updateFromState({
      tasksByStatus: {},
      tasksByAgentAndStatus: [],
      staleTasks: [],
      schedulerUp: false,
    });
    expect(await getMetricValue(metrics, "aof_scheduler_up")).toBe(0);
  });
});
