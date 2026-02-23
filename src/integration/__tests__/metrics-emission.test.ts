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
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";
import { AOFMetrics } from "../../metrics/exporter.js";
import { AOFService } from "../../service/aof-service.js";
import { collectMetrics } from "../../metrics/collector.js";
import { acquireLease } from "../../store/lease.js";
import { getMetricValue } from "../../testing/index.js";

describe("Metrics emission (AOF-honeycomb-005)", () => {
  let tmpDir: string;
  let store: FilesystemTaskStore;
  let logger: EventLogger;
  let metrics: AOFMetrics;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-metrics-emission-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
    metrics = new AOFMetrics();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("poll duration histogram increments after each scheduler poll", async () => {
    const before =
      (await getMetricValue(metrics, "aof_scheduler_loop_duration_seconds_count")) ?? 0;

    const service = new AOFService(
      { store, logger, metrics },
      { dataDir: tmpDir, dryRun: true, pollIntervalMs: 60_000 },
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
      { store, logger, metrics, poller: failingPoller },
      { dataDir: tmpDir, dryRun: false, pollIntervalMs: 60_000 },
    );
    await service.start();
    await service.stop();

    const after =
      (await getMetricValue(metrics, "aof_scheduler_poll_failures_total")) ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("aof_tasks_total gauge reflects task state after collectMetrics + updateFromState", async () => {
    const task = await store.create({
      title: "Ready Task",
      routing: { agent: "swe-qa" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const state = await collectMetrics(store);
    metrics.updateFromState(state);

    const count = await getMetricValue(metrics, "aof_tasks_total", {
      state: "ready",
      agent: "all",
    });
    expect(count).toBe(1);
  });

  it("per-agent task gauge labelled correctly after dispatch", async () => {
    const task = await store.create({
      title: "In-Progress Task",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");
    await acquireLease(store, task.frontmatter.id, "swe-backend");

    const state = await collectMetrics(store);
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
