import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHarness, type TestHarness } from "../../testing/index.js";
import { AOFMetrics } from "../../metrics/exporter.js";
import { AOFService } from "../../service/aof-service.js";
import { createMetricsHandler, createStatusHandler } from "../handlers.js";

describe("Gateway handlers", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness("aof-gateway-test");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("serves /metrics with scheduler status", async () => {
    const metrics = new AOFMetrics();
    const service = new AOFService({ store: harness.store, logger: harness.logger }, { dataDir: harness.tmpDir, dryRun: true });

    const handler = createMetricsHandler({ store: harness.store, metrics, service });
    const response = await handler({ method: "GET", path: "/metrics" });

    expect(response.status).toBe(200);
    expect(response.headers?.["Content-Type"]).toBe(metrics.registry.contentType);
    expect(response.body).toContain("aof_scheduler_up 0");
  });

  it("serves /aof/status with service status", async () => {
    const service = new AOFService({ store: harness.store, logger: harness.logger }, { dataDir: harness.tmpDir, dryRun: true });
    const handler = createStatusHandler(service);

    const response = await handler({ method: "GET", path: "/aof/status" });
    const body = JSON.parse(response.body) as { running: boolean };

    expect(response.status).toBe(200);
    expect(body.running).toBe(false);
  });

  it("ODD: /aof/status running=true after service start", async () => {
    const service = new AOFService({ store: harness.store, logger: harness.logger }, { dataDir: harness.tmpDir, dryRun: true });
    const handler = createStatusHandler(service);

    await service.start();

    const response = await handler({ method: "GET", path: "/aof/status" });
    const body = JSON.parse(response.body) as { running: boolean; lastPollAt?: string };

    expect(response.status).toBe(200);
    // ODD: running state reflected in observable status endpoint
    expect(body.running).toBe(true);
    expect(body.lastPollAt).toBeDefined();

    await service.stop();
  });

  it("ODD: /aof/status Content-Type is application/json", async () => {
    const service = new AOFService({ store: harness.store, logger: harness.logger }, { dataDir: harness.tmpDir, dryRun: true });
    const handler = createStatusHandler(service);

    const response = await handler({ method: "GET", path: "/aof/status" });

    expect(response.headers?.["Content-Type"]).toBe("application/json");
  });

  it("ODD: /metrics reflects task state (aof_tasks_total)", async () => {
    const metrics = new AOFMetrics();
    const service = new AOFService({ store: harness.store, logger: harness.logger }, { dataDir: harness.tmpDir, dryRun: true });
    const handler = createMetricsHandler({ store: harness.store, metrics, service });

    // Create and transition tasks
    const task = await harness.store.create({
      title: "Handler metrics task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    await harness.store.transition(task.frontmatter.id, "ready");

    const response = await handler({ method: "GET", path: "/metrics" });

    expect(response.status).toBe(200);
    // ODD: metric body includes aof_tasks_total gauge (from collectMetrics)
    expect(response.body).toContain("aof_tasks_total");
  });

  it("ODD: /metrics returns 500 on metrics collection error", async () => {
    const metrics = new AOFMetrics();
    const service = new AOFService({ store: harness.store, logger: harness.logger }, { dataDir: harness.tmpDir, dryRun: true });

    // Use a store stub that throws to simulate a collection error
    const brokenStore = {
      ...harness.store,
      list: async () => { throw new Error("Store unavailable"); },
    } as unknown as typeof harness.store;

    const handler = createMetricsHandler({ store: brokenStore, metrics, service });
    const response = await handler({ method: "GET", path: "/metrics" });

    // ODD: error path → 500 status with error message
    expect(response.status).toBe(500);
    expect(response.body).toContain("Error:");
  });
});
