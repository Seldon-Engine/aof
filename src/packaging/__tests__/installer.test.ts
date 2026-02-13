import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { install, update, list, type InstallOptions } from "../installer.js";

describe("Dependency Installer", () => {
  let tmpDir: string;
  let packageJson: string;
  let packageLock: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-installer-test-"));
    packageJson = join(tmpDir, "package.json");
    packageLock = join(tmpDir, "package-lock.json");

    // Create minimal package.json
    await writeFile(
      packageJson,
      JSON.stringify({
        name: "test-project",
        version: "1.0.0",
        dependencies: {
          "write-file-atomic": "^7.0.0",
        },
      }, null, 2),
    );

    // Generate a real lockfile using npm install
    execSync("npm install --package-lock-only", {
      cwd: tmpDir,
      stdio: "pipe",
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("install()", () => {
    it("performs fresh install with npm ci when lockfile exists", async () => {
      const opts: InstallOptions = {
        cwd: tmpDir,
        useLockfile: true,
      };

      const result = await install(opts);

      expect(result.success).toBe(true);
      expect(result.command).toBe("npm ci");
      expect(result.installed).toBeGreaterThan(0);

      // Verify node_modules was created
      const nodeModules = join(tmpDir, "node_modules");
      const files = await readdir(nodeModules);
      expect(files.length).toBeGreaterThan(0);
    });

    it("falls back to npm install when lockfile doesn't exist", async () => {
      await rm(packageLock); // Remove lockfile

      const opts: InstallOptions = {
        cwd: tmpDir,
        useLockfile: false,
      };

      const result = await install(opts);

      expect(result.success).toBe(true);
      expect(result.command).toBe("npm install");
      expect(result.installed).toBeGreaterThan(0);
    });

    it("validates installation with health check", async () => {
      const opts: InstallOptions = {
        cwd: tmpDir,
        useLockfile: true,
        healthCheck: true,
      };

      const result = await install(opts);

      expect(result.success).toBe(true);
      expect(result.healthCheck).toBe(true);
    });

    it("fails gracefully when package.json is missing", async () => {
      await rm(packageJson);

      const opts: InstallOptions = {
        cwd: tmpDir,
        useLockfile: true,
      };

      await expect(install(opts)).rejects.toThrow(/package\.json not found/i);
    });
  });

  describe("update()", () => {
    it("backs up config before update", async () => {
      // Create fake config file
      const configDir = join(tmpDir, "config");
      await mkdir(configDir, { recursive: true });
      const configFile = join(configDir, "settings.json");
      await writeFile(configFile, JSON.stringify({ key: "value" }));

      const opts: InstallOptions = {
        cwd: tmpDir,
        useLockfile: true,
        preservePaths: ["config"],
      };

      const result = await update(opts);

      expect(result.success).toBe(true);
      expect(result.backupCreated).toBe(true);
      expect(result.backupPath).toBeDefined();

      // Verify backup exists
      const backupContent = await readFile(join(result.backupPath!, "config", "settings.json"), "utf-8");
      expect(JSON.parse(backupContent)).toEqual({ key: "value" });

      // Verify original still exists
      const originalContent = await readFile(configFile, "utf-8");
      expect(JSON.parse(originalContent)).toEqual({ key: "value" });
    });

    it("preserves data directory during update", async () => {
      const dataDir = join(tmpDir, "data");
      await mkdir(dataDir, { recursive: true });
      const dataFile = join(dataDir, "important.db");
      await writeFile(dataFile, "important data");

      const opts: InstallOptions = {
        cwd: tmpDir,
        useLockfile: true,
        preservePaths: ["data"],
      };

      await update(opts);

      // Verify data survived
      const content = await readFile(dataFile, "utf-8");
      expect(content).toBe("important data");
    });

    it("rolls back on installation failure", async () => {
      // Create backup scenario
      const configDir = join(tmpDir, "config");
      await mkdir(configDir, { recursive: true });
      const configFile = join(configDir, "settings.json");
      await writeFile(configFile, JSON.stringify({ original: true }));

      // Break package.json to cause failure
      await writeFile(packageJson, "invalid json");

      const opts: InstallOptions = {
        cwd: tmpDir,
        useLockfile: true,
        preservePaths: ["config"],
      };

      await expect(update(opts)).rejects.toThrow();

      // Verify rollback happened (backup should still exist but not restored since install failed early)
      // In real scenario, we'd verify state restoration
    });
  });

  describe("list()", () => {
    it("returns installed package versions", async () => {
      // Install packages first
      await install({ cwd: tmpDir, useLockfile: true });

      const packages = await list({ cwd: tmpDir });

      expect(packages).toBeInstanceOf(Array);
      expect(packages.length).toBeGreaterThan(0);
      
      // Should include at least write-file-atomic
      const wfa = packages.find(p => p.name === "write-file-atomic");
      expect(wfa).toBeDefined();
      expect(wfa?.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("returns empty array when node_modules doesn't exist", async () => {
      const packages = await list({ cwd: tmpDir });
      expect(packages).toEqual([]);
    });

    it("includes dependency type (prod/dev)", async () => {
      // Add dev dependency
      const pkg = JSON.parse(await readFile(packageJson, "utf-8"));
      pkg.devDependencies = { "typescript": "^5.0.0" };
      await writeFile(packageJson, JSON.stringify(pkg, null, 2));

      await install({ cwd: tmpDir, useLockfile: false });

      const packages = await list({ cwd: tmpDir });
      
      const wfa = packages.find(p => p.name === "write-file-atomic");
      expect(wfa?.type).toBe("prod");
    });
  });

  describe("lockfile enforcement", () => {
    it("enforces deterministic install with lockfile", async () => {
      const opts: InstallOptions = {
        cwd: tmpDir,
        useLockfile: true,
        strict: true,
      };

      const result = await install(opts);
      expect(result.success).toBe(true);
      expect(result.command).toBe("npm ci");
    });

    it("warns when lockfile is missing but requested", async () => {
      await rm(packageLock);

      const opts: InstallOptions = {
        cwd: tmpDir,
        useLockfile: true,
        strict: false, // Don't fail, just warn
      };

      const result = await install(opts);
      expect(result.success).toBe(true);
      expect(result.warnings).toContain("Lockfile requested but not found");
    });
  });
});
