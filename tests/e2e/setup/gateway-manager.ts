/**
 * GatewayManager — Manage OpenClaw gateway subprocess for E2E tests.
 * 
 * Handles:
 * - Starting/stopping gateway with isolated profile
 * - Generating test configuration
 * - Health checks with retry
 * - API wrappers for tools, CLI, services, sessions
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface GatewayManagerOptions {
  profile: string;
  port: number;
  token: string;
  aofDataDir: string;
  aofPluginPath: string;
  verbose?: boolean;
}

export interface ToolCallResult {
  ok: boolean;
  [key: string]: any;
}

export interface ServiceInfo {
  name: string;
  running: boolean;
  [key: string]: any;
}

export interface SessionInfo {
  sessionId: string;
  agent: string;
  [key: string]: any;
}

export class GatewayManager {
  private process?: ChildProcess;
  private options: GatewayManagerOptions;
  private stateDir: string;
  private baseUrl: string;

  constructor(options: GatewayManagerOptions) {
    this.options = options;
    this.stateDir = join(homedir(), `.openclaw-${options.profile}`);
    this.baseUrl = `http://localhost:${options.port}`;
    
    // CI environment adjustments
    if (process.env.CI === "true") {
      console.log("[GatewayManager] CI mode detected — using extended timeouts");
    }
  }

  /**
   * Start the gateway subprocess with test configuration.
   */
  async start(): Promise<void> {
    // Ensure clean state
    await this.cleanup();
    await mkdir(this.stateDir, { recursive: true });

    // Generate OpenClaw config
    await this.generateConfig();

    // Start gateway process
    this.process = spawn(
      "openclaw",
      [
        "--profile",
        this.options.profile,
        "gateway",
        "run",
        "--port",
        String(this.options.port),
        "--token",
        this.options.token,
        "--bind",
        "loopback",
      ],
      {
        stdio: this.options.verbose ? "inherit" : "pipe",
        env: { ...process.env },
      }
    );

    // Handle process errors
    this.process.on("error", (error) => {
      throw new Error(`Gateway process error: ${error.message}`);
    });

    // Wait for gateway to be ready
    await this.waitForHealth();
  }

  /**
   * Stop the gateway subprocess.
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      await setTimeout(2000);
      if (!this.process.killed) {
        this.process.kill("SIGKILL");
      }
      this.process = undefined;
    }
  }

  /**
   * Clean up state directory and AOF data directory.
   */
  async cleanup(): Promise<void> {
    await rm(this.stateDir, { recursive: true, force: true });
    await rm(this.options.aofDataDir, { recursive: true, force: true });
  }

  /**
   * Generate OpenClaw configuration file for tests.
   */
  private async generateConfig(): Promise<void> {
    const config = {
      version: "2026.2.6",
      gateway: {
        mode: "local",
        bind: "loopback",
        port: this.options.port,
        auth: "token",
      },
      models: {
        providers: {
          "mock-test": {
            type: "echo", // OpenClaw's echo provider for deterministic responses
            prefix: "Task acknowledged: ",
          },
        },
      },
      agents: {
        "test-agent-1": {
          model: "anthropic-api/claude-sonnet-4",
          tools: ["aof_task_update", "aof_status_report", "aof_task_complete"],
          workspace: join(this.stateDir, "workspace-agent-1"),
        },
        "test-agent-2": {
          model: "anthropic-api/claude-sonnet-4",
          tools: ["aof_task_update", "aof_status_report", "aof_task_complete"],
          workspace: join(this.stateDir, "workspace-agent-2"),
        },
        "test-agent-3": {
          model: "anthropic-api/claude-sonnet-4",
          tools: ["aof_task_update", "aof_status_report", "aof_task_complete"],
          workspace: join(this.stateDir, "workspace-agent-3"),
        },
      },
      plugins: [
        {
          name: "aof",
          path: this.options.aofPluginPath,
          options: {
            dataDir: this.options.aofDataDir,
            dryRun: false,
            pollIntervalMs: 1000,
            defaultLeaseTtlMs: 30000,
          },
        },
      ],
    };

    const configPath = join(this.stateDir, "openclaw.json");
    await writeFile(configPath, JSON.stringify(config, null, 2));
  }

  /**
   * Wait for gateway to be healthy (with retry).
   */
  private async waitForHealth(): Promise<void> {
    // CI environment gets 2x timeout
    const baseMaxAttempts = 30;
    const maxAttempts = process.env.CI === "true" ? baseMaxAttempts * 2 : baseMaxAttempts;
    const delayMs = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          if (process.env.CI === "true") {
            console.log(`[GatewayManager] Gateway ready after ${i + 1} attempts`);
          }
          return;
        }
      } catch {
        // Gateway not ready yet
        if (process.env.CI === "true" && i % 10 === 0 && i > 0) {
          console.log(`[GatewayManager] Still waiting for gateway... (${i}/${maxAttempts})`);
        }
      }
      await setTimeout(delayMs);
    }

    throw new Error(
      `Gateway failed to start after ${maxAttempts * delayMs}ms`
    );
  }

  /**
   * Call an AOF tool via gateway HTTP API.
   */
  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    const response = await fetch(`${this.baseUrl}/api/tools/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify({ input }),
    });

    if (!response.ok) {
      throw new Error(
        `Tool call failed: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
  }

  /**
   * Call an AOF CLI command via gateway HTTP API.
   */
  async callCli(command: string, args: string[]): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/cli`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify({ command, args }),
    });

    if (!response.ok) {
      throw new Error(
        `CLI call failed: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
  }

  /**
   * List all registered services.
   */
  async listServices(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/services`, {
      headers: { Authorization: `Bearer ${this.options.token}` },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to list services: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    return data.services.map((s: ServiceInfo) => s.name);
  }

  /**
   * List all registered tools.
   */
  async listTools(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tools`, {
      headers: { Authorization: `Bearer ${this.options.token}` },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to list tools: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    return data.tools.map((t: any) => t.name);
  }

  /**
   * List all registered CLI commands.
   */
  async listClis(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/clis`, {
      headers: { Authorization: `Bearer ${this.options.token}` },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to list CLIs: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    return data.clis.map((c: any) => c.name);
  }

  /**
   * Start a service.
   */
  async startService(name: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/services/${name}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.token}` },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to start service: ${response.status} ${response.statusText}`
      );
    }
  }

  /**
   * Stop a service.
   */
  async stopService(name: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/services/${name}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.token}` },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to stop service: ${response.status} ${response.statusText}`
      );
    }
  }

  /**
   * List active sessions.
   */
  async listSessions(): Promise<SessionInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${this.options.token}` },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to list sessions: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    return data.sessions;
  }

  /**
   * Kill a session.
   */
  async killSession(sessionId: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/kill`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.token}` },
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to kill session: ${response.status} ${response.statusText}`
      );
    }
  }
}

/**
 * Singleton gateway instance for test suites.
 */
let gatewayInstance: GatewayManager | undefined;

/**
 * Start a test gateway (singleton).
 */
export async function startTestGateway(): Promise<GatewayManager> {
  if (gatewayInstance) {
    await gatewayInstance.stop();
  }

  gatewayInstance = new GatewayManager({
    profile: "aof-e2e-test",
    port: 19003,
    token: "test-token-12345",
    aofDataDir: join(homedir(), ".openclaw-aof-e2e-test", "aof-test-data"),
    aofPluginPath: join(process.cwd(), "dist", "index.js"),
    verbose: process.env.VERBOSE_TESTS === "true",
  });

  await gatewayInstance.start();
  return gatewayInstance;
}

/**
 * Stop and cleanup test gateway.
 */
export async function stopTestGateway(): Promise<void> {
  if (gatewayInstance) {
    await gatewayInstance.stop();
    await gatewayInstance.cleanup();
    gatewayInstance = undefined;
  }
}
