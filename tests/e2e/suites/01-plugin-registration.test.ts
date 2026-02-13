/**
 * E2E Test: Plugin Registration
 * 
 * Verifies that:
 * - AOF plugin loads successfully in OpenClaw gateway
 * - All tools are registered (aof_task_update, aof_status_report, aof_task_complete)
 * - All CLI commands are registered (aof lint, aof board, aof drift)
 * - All services are registered (aof-scheduler)
 * - Gateway endpoints are accessible (/metrics, /aof/status)
 * 
 * ⚠️ BLOCKED: OpenClaw 2026.2.6 does not support loading custom plugins via config.
 * See FINDINGS.md for details.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, stopTestGateway } from "../setup/gateway-manager.js";
import { seedTestData } from "../utils/test-data.js";
import { homedir } from "node:os";
import { join } from "node:path";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "aof-test-data");

describe.skip("E2E: Plugin Registration", () => {
  beforeAll(async () => {
    // Start gateway and seed test data
    const gateway = await startTestGateway();
    await seedTestData(TEST_DATA_DIR);
  }, 60_000);

  afterAll(async () => {
    await stopTestGateway();
  });

  it("should load AOF plugin and register aof-scheduler service", async () => {
    const gateway = await startTestGateway();
    const services = await gateway.listServices();

    expect(services).toContain("aof-scheduler");
  });

  it("should register all AOF tools", async () => {
    const gateway = await startTestGateway();
    const tools = await gateway.listTools();

    expect(tools).toContain("aof_dispatch");
    expect(tools).toContain("aof_task_update");
    expect(tools).toContain("aof_status_report");
    expect(tools).toContain("aof_task_complete");
  });

  it("should register all AOF CLI commands", async () => {
    const gateway = await startTestGateway();
    const clis = await gateway.listClis();

    expect(clis).toContain("aof lint");
    expect(clis).toContain("aof board");
    expect(clis).toContain("aof drift");
  });

  it("should expose /metrics endpoint", async () => {
    const response = await fetch("http://localhost:19003/metrics");
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toContain("# HELP");
    expect(text).toContain("# TYPE");
  });

  it("should expose /aof/status endpoint", async () => {
    const response = await fetch("http://localhost:19003/aof/status");
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("scheduler");
    expect(data).toHaveProperty("tasks");
  });
});
