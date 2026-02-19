/**
 * Integration tests for AOF OpenClaw plugin.
 * 
 * These tests run against a REAL containerized OpenClaw instance.
 * They validate that the plugin:
 * - Loads without crashing the gateway
 * - Registers all expected tools
 * - Registers the service
 * - Exposes HTTP routes
 * 
 * Prerequisites:
 * - Docker + Docker Compose installed
 * - AOF built (`npm run build` from repo root)
 * 
 * Run: npm run test:integration:plugin
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";

const execAsync = promisify(exec);

const GATEWAY_URL = "http://localhost:19003";
const GATEWAY_TOKEN = "test-token-12345";
const COMPOSE_DIR = new URL("./openclaw", import.meta.url).pathname;
const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 1000;

async function waitForGateway(timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${GATEWAY_URL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return;
    } catch {
      // Gateway not ready yet
    }
    await setTimeout(HEALTH_CHECK_INTERVAL_MS);
  }
  throw new Error(`Gateway did not become healthy within ${timeoutMs}ms`);
}

async function callGatewayApi(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${GATEWAY_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      "Authorization": `Bearer ${GATEWAY_TOKEN}`,
    },
  });
}

// SKIP: This test suite requires Docker + Mule (containerized OpenClaw gateway).
// Run manually with `npm run test:integration:plugin` in an environment with Docker installed.
describe.skip("AOF Plugin Integration (Real OpenClaw)", () => {
  beforeAll(async () => {
    console.log("[setup] Starting containerized OpenClaw gateway...");
    
    // Start the container
    await execAsync("docker compose up -d --build", { cwd: COMPOSE_DIR });
    
    // Wait for gateway to be healthy
    console.log("[setup] Waiting for gateway to be ready...");
    await waitForGateway(STARTUP_TIMEOUT_MS);
    
    console.log("[setup] Gateway is ready.");
  }, STARTUP_TIMEOUT_MS + 5000);

  afterAll(async () => {
    console.log("[teardown] Stopping containerized OpenClaw gateway...");
    await execAsync("docker compose down", { cwd: COMPOSE_DIR });
  }, 15_000);

  it("should load plugin without crashing gateway", async () => {
    const response = await fetch(`${GATEWAY_URL}/health`);
    expect(response.ok).toBe(true);
  });

  it("should expose /aof/status endpoint", async () => {
    const response = await fetch(`${GATEWAY_URL}/aof/status`);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data).toHaveProperty("running");
    expect(data).toHaveProperty("pollIntervalMs");
  });

  it("should expose /aof/metrics endpoint", async () => {
    const response = await fetch(`${GATEWAY_URL}/aof/metrics`);
    expect(response.status).toBe(200);
    
    const text = await response.text();
    expect(text).toContain("# HELP");
    expect(text).toContain("# TYPE");
  });

  // Note: The following tests require OpenClaw to expose plugin registry endpoints.
  // If these endpoints don't exist in OpenClaw 2026.2.6, these tests will be skipped.
  
  it.skip("should register aof-scheduler service", async () => {
    const response = await callGatewayApi("/api/services");
    expect(response.ok).toBe(true);
    
    const data = await response.json();
    const serviceIds = data.services?.map((s: any) => s.id || s.name) || [];
    expect(serviceIds).toContain("aof-scheduler");
  });

  it.skip("should register AOF tools", async () => {
    const response = await callGatewayApi("/api/tools");
    expect(response.ok).toBe(true);
    
    const data = await response.json();
    const toolNames = data.tools?.map((t: any) => t.name) || [];
    
    expect(toolNames).toContain("aof_dispatch");
    expect(toolNames).toContain("aof_task_update");
    expect(toolNames).toContain("aof_status_report");
    expect(toolNames).toContain("aof_task_complete");
  });
});
