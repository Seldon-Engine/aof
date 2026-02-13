import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ejectFromOpenClaw,
  detectOpenClawIntegration,
  type EjectionOptions,
  type EjectionResult,
} from "../ejector.js";
import { integrateWithOpenClaw } from "../integration.js";

describe("OpenClaw Ejection", () => {
  let tmpDir: string;
  let openclawConfigPath: string;
  let aofRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-ejector-test-"));
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

  describe("detectOpenClawIntegration()", () => {
    it("detects when AOF is integrated", async () => {
      // Create OpenClaw config with AOF plugin
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const result = await detectOpenClawIntegration(openclawConfigPath);

      expect(result.integrated).toBe(true);
      expect(result.configPath).toBe(openclawConfigPath);
    });

    it("returns not integrated when AOF plugin is missing", async () => {
      // Create OpenClaw config without AOF plugin
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "other-plugin",
            path: "/path/to/other-plugin.js",
            enabled: true,
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const result = await detectOpenClawIntegration(openclawConfigPath);

      expect(result.integrated).toBe(false);
    });

    it("handles missing OpenClaw config", async () => {
      const nonexistentPath = join(tmpDir, ".openclaw", "nonexistent.json");

      const result = await detectOpenClawIntegration(nonexistentPath);

      expect(result.integrated).toBe(false);
    });

    it("handles invalid JSON in OpenClaw config", async () => {
      await writeFile(openclawConfigPath, "{ invalid json", "utf-8");

      const result = await detectOpenClawIntegration(openclawConfigPath);

      expect(result.integrated).toBe(false);
    });
  });

  describe("ejectFromOpenClaw()", () => {
    it("removes AOF plugin from OpenClaw config", async () => {
      // Create integrated config
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: EjectionOptions = {
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await ejectFromOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.pluginRemoved).toBe(true);

      // Verify AOF plugin was removed
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(updatedConfig.plugins).toHaveLength(0);
      const aofPlugin = updatedConfig.plugins.find((p: any) => p.name === "aof");
      expect(aofPlugin).toBeUndefined();
    });

    it("preserves other plugins when ejecting AOF", async () => {
      // Create config with multiple plugins
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "other-plugin",
            path: "/path/to/other-plugin.js",
            enabled: true,
          },
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
          {
            name: "another-plugin",
            path: "/path/to/another-plugin.js",
            enabled: false,
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: EjectionOptions = {
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await ejectFromOpenClaw(opts);

      expect(result.success).toBe(true);

      // Verify other plugins are preserved
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(updatedConfig.plugins).toHaveLength(2);
      expect(updatedConfig.plugins[0].name).toBe("other-plugin");
      expect(updatedConfig.plugins[1].name).toBe("another-plugin");

      // Verify AOF is gone
      const aofPlugin = updatedConfig.plugins.find((p: any) => p.name === "aof");
      expect(aofPlugin).toBeUndefined();
    });

    it("creates backup before ejecting", async () => {
      // Create integrated config
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: EjectionOptions = {
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await ejectFromOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.backupCreated).toBe(true);
      expect(result.backupPath).toBeDefined();

      // Verify backup exists and contains original config
      const backupContent = await readFile(result.backupPath!, "utf-8");
      const backupConfig = JSON.parse(backupContent);
      expect(backupConfig.plugins).toHaveLength(1);
      expect(backupConfig.plugins[0].name).toBe("aof");
    });

    it("is idempotent (safe to re-run)", async () => {
      // Create integrated config
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: EjectionOptions = {
        openclawConfigPath,
        homeDir: tmpDir,
      };

      // Run ejection twice
      const result1 = await ejectFromOpenClaw(opts);
      expect(result1.success).toBe(true);
      expect(result1.pluginRemoved).toBe(true);

      const result2 = await ejectFromOpenClaw(opts);
      expect(result2.success).toBe(true);
      expect(result2.alreadyEjected).toBe(true);

      // Verify config is still valid
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(updatedConfig.plugins).toHaveLength(0);
    });

    it("preserves other config sections during ejection", async () => {
      // Create config with various sections
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
        ],
        memory: {
          pools: [
            {
              name: "existing-pool",
              path: "/path/to/existing-pool",
            },
          ],
        },
        customSection: {
          foo: "bar",
        },
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: EjectionOptions = {
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await ejectFromOpenClaw(opts);

      expect(result.success).toBe(true);

      // Verify other sections are preserved
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(updatedConfig.version).toBe("1.0.0");
      expect(updatedConfig.memory).toBeDefined();
      expect(updatedConfig.memory.pools).toHaveLength(1);
      expect(updatedConfig.customSection).toEqual({ foo: "bar" });
    });

    it("validates config after ejection", async () => {
      // Create integrated config
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: EjectionOptions = {
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await ejectFromOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.validationPassed).toBe(true);

      // Verify config is valid JSON
      const updatedConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(updatedConfig.version).toBeDefined();
      expect(Array.isArray(updatedConfig.plugins)).toBe(true);
    });

    it("handles missing OpenClaw config gracefully", async () => {
      const opts: EjectionOptions = {
        openclawConfigPath: join(tmpDir, ".openclaw", "nonexistent.json"),
        homeDir: tmpDir,
      };

      const result = await ejectFromOpenClaw(opts);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("includes warnings when appropriate", async () => {
      // Create integrated config
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      const opts: EjectionOptions = {
        openclawConfigPath,
        homeDir: tmpDir,
      };

      const result = await ejectFromOpenClaw(opts);

      expect(result.success).toBe(true);
      if (result.warnings && result.warnings.length > 0) {
        expect(Array.isArray(result.warnings)).toBe(true);
      }
    });
  });

  describe("re-integration after ejection", () => {
    it("allows re-integration after ejection", async () => {
      // Step 1: Create initial integrated config
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "other-plugin",
            path: "/path/to/other-plugin.js",
            enabled: true,
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      // Step 2: Integrate AOF
      const integrationResult = await integrateWithOpenClaw({
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      });
      expect(integrationResult.success).toBe(true);

      // Step 3: Eject AOF
      const ejectionResult = await ejectFromOpenClaw({
        openclawConfigPath,
        homeDir: tmpDir,
      });
      expect(ejectionResult.success).toBe(true);

      // Step 4: Re-integrate AOF
      const reintegrationResult = await integrateWithOpenClaw({
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      });
      expect(reintegrationResult.success).toBe(true);
      expect(reintegrationResult.pluginRegistered).toBe(true);

      // Final verification
      const finalConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(finalConfig.plugins).toHaveLength(2);
      expect(finalConfig.plugins.some((p: any) => p.name === "other-plugin")).toBe(true);
      expect(finalConfig.plugins.some((p: any) => p.name === "aof")).toBe(true);
    });

    it("preserves all non-AOF config through eject-integrate cycle", async () => {
      // Create complex config
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "plugin-a",
            path: "/path/to/plugin-a.js",
            enabled: true,
          },
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
          {
            name: "plugin-b",
            path: "/path/to/plugin-b.js",
            enabled: false,
          },
        ],
        memory: {
          pools: [
            {
              name: "pool-1",
              path: "/path/to/pool-1",
            },
          ],
        },
        customSection: {
          setting: "value",
        },
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      // Eject
      const ejectionResult = await ejectFromOpenClaw({
        openclawConfigPath,
        homeDir: tmpDir,
      });
      expect(ejectionResult.success).toBe(true);

      // Verify non-AOF config preserved
      const afterEject = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(afterEject.version).toBe("1.0.0");
      expect(afterEject.plugins).toHaveLength(2);
      expect(afterEject.memory.pools).toHaveLength(1);
      expect(afterEject.customSection.setting).toBe("value");

      // Re-integrate
      const integrationResult = await integrateWithOpenClaw({
        aofRoot,
        openclawConfigPath,
        homeDir: tmpDir,
      });
      expect(integrationResult.success).toBe(true);

      // Verify everything is back
      const afterIntegrate = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(afterIntegrate.version).toBe("1.0.0");
      expect(afterIntegrate.plugins).toHaveLength(3);
      expect(afterIntegrate.memory.pools).toHaveLength(1);
      expect(afterIntegrate.customSection.setting).toBe("value");
    });
  });

  describe("complete ejection workflow", () => {
    it("completes full ejection workflow", async () => {
      // Create integrated config
      const config = {
        version: "1.0.0",
        plugins: [
          {
            name: "other-plugin",
            path: "/other/plugin.js",
            enabled: true,
          },
          {
            name: "aof",
            path: join(aofRoot, "dist", "openclaw", "adapter.js"),
            enabled: true,
            config: { dataDir: aofRoot },
          },
        ],
      };
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2), "utf-8");

      // Step 1: Detect integration
      const detection = await detectOpenClawIntegration(openclawConfigPath);
      expect(detection.integrated).toBe(true);

      // Step 2: Eject
      const opts: EjectionOptions = {
        openclawConfigPath,
        homeDir: tmpDir,
      };
      const result = await ejectFromOpenClaw(opts);

      expect(result.success).toBe(true);
      expect(result.pluginRemoved).toBe(true);
      expect(result.backupCreated).toBe(true);
      expect(result.validationPassed).toBe(true);

      // Step 3: Verify ejection
      const detection2 = await detectOpenClawIntegration(openclawConfigPath);
      expect(detection2.integrated).toBe(false);

      // Step 4: Verify idempotency
      const result2 = await ejectFromOpenClaw(opts);
      expect(result2.success).toBe(true);
      expect(result2.alreadyEjected).toBe(true);

      // Final verification
      const finalConfig = JSON.parse(await readFile(openclawConfigPath, "utf-8"));
      expect(finalConfig.plugins).toHaveLength(1);
      expect(finalConfig.plugins[0].name).toBe("other-plugin");
      expect(finalConfig.plugins.some((p: any) => p.name === "aof")).toBe(false);
    });
  });
});
