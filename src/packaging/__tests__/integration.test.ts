import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  integrateWithOpenClaw,
  detectOpenClawConfig,
  type IntegrationOptions,
  type IntegrationResult,
} from "../integration.js";

describe("OpenClaw Integration", () => {
  let tmpDir: string;
  let openclawConfigPath: string;
  let aofRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-integration-test-"));
    openclawConfigPath = join(tmpDir, ".openclaw", "openclaw.json");
    aofRoot = join(tmpDir, "Projects", "AOF");

    // Create OpenClaw config directory
    await mkdir(join(tmpDir, ".openclaw"), { recursive: true });

    // Create AOF installation
    await mkdir(aofRoot, { recursive: true });
    await mkdir(join(aofRoot, "org"), { recursive: true });
    await mkdir(join(aofRoot, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("detectOpenClawConfig()", () => {
    it("detects existing OpenClaw config", async () => {
      // Create a minimal OpenClaw config
      const config = {
        version: "1.0.0",
        plugins: [],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const result = await detectOpenClawConfig(tmpDir);

      expect(result.detected).toBe(true);
      expect(result.configPath).toBe(openclawConfigPath);
    });

    it("returns not detected if config does not exist", async () => {
      const result = await detectOpenClawConfig(tmpDir);

      expect(result.detected).toBe(false);
      expect(result.configPath).toBeUndefined();
    });

    it("handles custom home directory", async () => {
      const customHome = join(tmpDir, "custom-home");
      await mkdir(join(customHome, ".openclaw"), { recursive: true });
      const customConfigPath = join(customHome, ".openclaw", "openclaw.json");
      await writeFile(customConfigPath, JSON.stringify({ version: "1.0.0" }), "utf-8");

      const result = await detectOpenClawConfig(customHome);

      expect(result.detected).toBe(true);
      expect(result.configPath).toBe(customConfigPath);
    });
  });

  describe("integrateWithOpenClaw()", () => {
    it("registers AOF plugin in empty config", async () => {
      // Create empty OpenClaw config
      const config = {
        version: "1.0.0",
        plugins: [],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.pluginRegistered).toBe(true);
      expect(result.memoryScopingConfigured).toBe(true);

      // Verify config was updated
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(updatedConfig.plugins).toHaveLength(1);
      expect(updatedConfig.plugins[0].name).toBe("aof");
      expect(updatedConfig.plugins[0].enabled).toBe(true);
      expect(updatedConfig.plugins[0].path).toContain("adapter.js");
    });

    it("preserves existing plugins when registering AOF", async () => {
      // Create OpenClaw config with existing plugins
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "existing-plugin",
            path: "/path/to/existing-plugin.js",
            enabled: true,
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(true);

      // Verify both plugins exist
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(updatedConfig.plugins).toHaveLength(2);
      expect(updatedConfig.plugins[0].name).toBe("existing-plugin");
      expect(updatedConfig.plugins[1].name).toBe("aof");
    });

    it("is idempotent (safe to re-run)", async () => {
      // Create OpenClaw config
      const config = {
        version: "1.0.0",
        plugins: [],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      };

      // Run integration twice
      const result1 = await integrateWithOpenClaw(opts);
      expect(result1.success).toBe(true);

      const result2 = await integrateWithOpenClaw(opts);
      expect(result2.success).toBe(true);
      expect(result2.alreadyIntegrated).toBe(true);

      // Verify only one AOF plugin exists
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      const aofPlugins = updatedConfig.plugins.filter((p: any) => p.name === "aof");
      expect(aofPlugins).toHaveLength(1);
    });

    it("configures memory scoping paths", async () => {
      // Create OpenClaw config
      const config = {
        version: "1.0.0",
        plugins: [],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.memoryScopingConfigured).toBe(true);

      // Verify memory config was added
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      const aofPlugin = updatedConfig.plugins.find((p: any) => p.name === "aof");
      expect(aofPlugin.config?.dataDir).toBe(aofRoot);
    });

    it("creates backup before modifying config", async () => {
      // Create OpenClaw config
      const config = {
        version: "1.0.0",
        plugins: [],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.backupCreated).toBe(true);
      expect(result.backupPath).toBeDefined();

      // Verify backup exists
      await access(result.backupPath!);
      const backupContent = await readFile(result.backupPath!, "utf-8");
      const backupConfig = JSON.parse(backupContent);
      expect(backupConfig.plugins).toHaveLength(0); // Original had no plugins
    });

    it("performs health check after integration", async () => {
      // Create OpenClaw config
      const config = {
        version: "1.0.0",
        plugins: [],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
        healthCheck: true,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.healthCheckPassed).toBeDefined();
    });

    it("validates config after modification", async () => {
      // Create OpenClaw config
      const config = {
        version: "1.0.0",
        plugins: [],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.validationPassed).toBe(true);

      // Verify config is valid JSON
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(updatedConfig.version).toBeDefined();
      expect(Array.isArray(updatedConfig.plugins)).toBe(true);
    });

    it("handles config with memory pools already defined", async () => {
      // Create OpenClaw config with existing memory pools
      const config = {
        version: "1.0.0",
        plugins: [],
        memory: {
          pools: [
            {
              name: "existing-pool",
              path: "/path/to/existing-pool",
            },
          ],
        },
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(true);

      // Verify existing memory pools are preserved
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(updatedConfig.memory?.pools).toBeDefined();
      const existingPool = updatedConfig.memory.pools.find(
        (p: any) => p.name === "existing-pool",
      );
      expect(existingPool).toBeDefined();
    });

    it("handles missing OpenClaw config gracefully", async () => {
      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath: join(tmpDir, ".openclaw", "nonexistent.json"),
        homeDir: tmpDir,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("handles invalid JSON in OpenClaw config", async () => {
      // Write invalid JSON
      await writeFile(openclawConfigPath, "{ invalid json", "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("includes warnings when appropriate", async () => {
      // Create OpenClaw config
      const config = {
        version: "1.0.0",
        plugins: [],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(true);
      // Warnings might include "Gateway restart recommended" etc.
      if (result.warnings && result.warnings.length > 0) {
        expect(Array.isArray(result.warnings)).toBe(true);
      }
    });
  });

  describe("integration workflow", () => {
    it("completes full integration workflow", async () => {
      // Create OpenClaw config
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "other-plugin",
            path: "/other/plugin.js",
            enabled: true,
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      // Step 1: Detect
      const detection = await detectOpenClawConfig(tmpDir);
      expect(detection.detected).toBe(true);

      // Step 2: Integrate
      const opts: IntegrationOptions = {
        aofRoot,
        openclawConfigPath: detection.configPath!,
        homeDir: tmpDir,
        healthCheck: true,
      };
      const result = await integrateWithOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.pluginRegistered).toBe(true);
      expect(result.memoryScopingConfigured).toBe(true);
      expect(result.backupCreated).toBe(true);
      expect(result.validationPassed).toBe(true);

      // Step 3: Verify idempotency
      const result2 = await integrateWithOpenClaw(opts);
      expect(result2.success).toBe(true);
      expect(result2.alreadyIntegrated).toBe(true);

      // Final verification
      const finalConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(finalConfig.plugins).toHaveLength(2);
      expect(finalConfig.plugins.some((p: any) => p.name === "other-plugin")).toBe(true);
      expect(finalConfig.plugins.some((p: any) => p.name === "aof")).toBe(true);
    });
  });
});
