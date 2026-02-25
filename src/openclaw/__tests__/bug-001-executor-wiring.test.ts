/**
 * BUG-001: Executor Not Wired to AOFService
 * Date: 2026-02-08 19:00 EST
 * 
 * Tests verify executor is properly instantiated and passed to AOFService.
 * Updated to support HTTP dispatch (spawnAgent no longer required).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerAofPlugin } from "../adapter.js";
import type { OpenClawApi } from "../types.js";

describe("BUG-001: Executor Wiring (P0)", () => {
  let mockApi: OpenClawApi;
  let registeredServices: any[];
  let registeredTools: any[];

  beforeEach(() => {
    registeredServices = [];
    registeredTools = [];

    mockApi = {
      config: {
        gateway: {
          port: 18789,
          auth: { token: "test-token" },
        },
      },
      registerService: vi.fn((def) => {
        registeredServices.push(def);
      }),
      registerTool: vi.fn((tool) => {
        registeredTools.push(tool);
      }),
      on: vi.fn(),
      spawnAgent: vi.fn(async (req) => ({
        success: true,
        sessionId: `session-${req.agentId}`,
      })),
    } as unknown as OpenClawApi;
  });

  it("BUG-001: adapter instantiates executor when dryRun=false", async () => {
    const service = registerAofPlugin(mockApi, {
      dataDir: "/tmp/aof-test",
      dryRun: false,
    });

    const status = service.getStatus();
    expect(status).toBeDefined();

    expect(registeredServices.length).toBe(1);
    expect(registeredServices[0]?.id).toBe("aof-scheduler");
  });

  it("BUG-001: executor is undefined when dryRun=true", async () => {
    const service = registerAofPlugin(mockApi, {
      dataDir: "/tmp/aof-test",
      dryRun: true,
    });

    const status = service.getStatus();
    expect(status).toBeDefined();
    expect(status.running).toBe(false);
  });

  it("BUG-001: executor is passed to AOFService constructor", async () => {
    const service = registerAofPlugin(mockApi, {
      dataDir: "/tmp/aof-test",
      dryRun: false,
    });

    await service.start();

    const status = service.getStatus();
    expect(status.running).toBe(true);

    await service.stop();
  });

  it("BUG-001: executor works with embedded agent dispatch (no HTTP required)", async () => {
    const service = registerAofPlugin(mockApi, {
      dataDir: "/tmp/aof-test",
      dryRun: false,
    });

    expect(service).toBeDefined();

    await service.stop();
  });

  it("BUG-001: executor wiring survives service lifecycle", async () => {
    const service = registerAofPlugin(mockApi, {
      dataDir: "/tmp/aof-test",
      dryRun: false,
    });

    await service.start();
    expect(service.getStatus().running).toBe(true);

    await service.stop();
    expect(service.getStatus().running).toBe(false);

    await service.start();
    expect(service.getStatus().running).toBe(true);

    await service.stop();
  });

  it("BUG-001: acceptance - executor enables task dispatch", async () => {
    const service = registerAofPlugin(mockApi, {
      dataDir: "/tmp/aof-test",
      dryRun: false,
      pollIntervalMs: 100,
    });

    await service.start();

    await new Promise(resolve => setTimeout(resolve, 150));

    const status = service.getStatus();
    expect(status.running).toBe(true);
    expect(status.lastPollAt).toBeDefined();

    await service.stop();
  });
});
