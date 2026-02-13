/**
 * Channel Infrastructure Tests
 * TDD: Tests written first for P4.5-002
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getChannel,
  setChannel,
  getVersionManifest,
  checkForUpdates,
  createBackup,
  rollback,
  type Channel,
  type VersionManifest,
  type UpdatePolicy,
} from "../channels.js";

describe("Channel Management", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `aof-channels-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("getChannel", () => {
    it("should return default channel (stable) when no config exists", async () => {
      const channel = await getChannel(testDir);
      expect(channel).toBe("stable");
    });

    it("should read channel from config file", async () => {
      const configPath = join(testDir, ".aof", "channel.json");
      await mkdir(join(testDir, ".aof"), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channel: "beta" }));

      const channel = await getChannel(testDir);
      expect(channel).toBe("beta");
    });

    it("should fallback to stable on invalid channel", async () => {
      const configPath = join(testDir, ".aof", "channel.json");
      await mkdir(join(testDir, ".aof"), { recursive: true });
      await writeFile(configPath, JSON.stringify({ channel: "invalid" }));

      const channel = await getChannel(testDir);
      expect(channel).toBe("stable");
    });
  });

  describe("setChannel", () => {
    it("should set channel to stable", async () => {
      await setChannel(testDir, "stable");
      const channel = await getChannel(testDir);
      expect(channel).toBe("stable");
    });

    it("should set channel to beta", async () => {
      await setChannel(testDir, "beta");
      const channel = await getChannel(testDir);
      expect(channel).toBe("beta");
    });

    it("should set channel to canary", async () => {
      await setChannel(testDir, "canary");
      const channel = await getChannel(testDir);
      expect(channel).toBe("canary");
    });

    it("should reject invalid channel", async () => {
      await expect(
        setChannel(testDir, "invalid" as Channel)
      ).rejects.toThrow("Invalid channel");
    });

    it("should create .aof directory if missing", async () => {
      await setChannel(testDir, "beta");
      const configPath = join(testDir, ".aof", "channel.json");
      const content = await readFile(configPath, "utf-8");
      expect(JSON.parse(content).channel).toBe("beta");
    });
  });

  describe("getVersionManifest", () => {
    it("should parse stable version manifest", async () => {
      const mockResponse = {
        tag_name: "v1.0.0",
        name: "Release 1.0.0",
        body: "# Changelog\n- Feature A\n- Bug fix B",
        published_at: "2026-02-01T10:00:00Z",
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const manifest = await getVersionManifest("stable");
      expect(manifest.channel).toBe("stable");
      expect(manifest.version).toBe("1.0.0");
      expect(manifest.publishedAt).toBe("2026-02-01T10:00:00Z");
      expect(manifest.changelog).toContain("Feature A");
    });

    it("should parse beta version manifest", async () => {
      const mockResponse = [
        {
          tag_name: "v1.1.0-rc.1",
          name: "Release 1.1.0-rc.1",
          body: "# Changelog\n- Feature C (beta)",
          published_at: "2026-02-05T10:00:00Z",
        },
        {
          tag_name: "v1.0.0",
          name: "Release 1.0.0",
          body: "Stable",
          published_at: "2026-02-01T10:00:00Z",
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const manifest = await getVersionManifest("beta");
      expect(manifest.channel).toBe("beta");
      expect(manifest.version).toBe("1.1.0-rc.1");
    });

    it("should handle canary (main branch)", async () => {
      const mockResponse = {
        sha: "abc123def456",
        commit: {
          message: "feat: new feature",
          author: { date: "2026-02-07T10:00:00Z" },
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const manifest = await getVersionManifest("canary");
      expect(manifest.channel).toBe("canary");
      expect(manifest.version).toBe("canary-abc123d");
      expect(manifest.publishedAt).toBe("2026-02-07T10:00:00Z");
    });

    it("should handle fetch errors gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      await expect(getVersionManifest("stable")).rejects.toThrow("Failed to fetch version manifest");
    });
  });

  describe("checkForUpdates", () => {
    it("should detect available update", async () => {
      const configPath = join(testDir, ".aof", "channel.json");
      await mkdir(join(testDir, ".aof"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ channel: "stable", version: "0.9.0" })
      );

      const mockManifest = {
        channel: "stable" as Channel,
        version: "1.0.0",
        publishedAt: "2026-02-01T10:00:00Z",
        changelog: "New version",
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v1.0.0",
          name: "Release 1.0.0",
          body: "New version",
          published_at: "2026-02-01T10:00:00Z",
        }),
      } as Response);

      const result = await checkForUpdates(testDir);
      expect(result.updateAvailable).toBe(true);
      expect(result.currentVersion).toBe("0.9.0");
      expect(result.latestVersion).toBe("1.0.0");
    });

    it("should indicate no update when current", async () => {
      const configPath = join(testDir, ".aof", "channel.json");
      await mkdir(join(testDir, ".aof"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ channel: "stable", version: "1.0.0" })
      );

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v1.0.0",
          name: "Release 1.0.0",
          body: "Current version",
          published_at: "2026-02-01T10:00:00Z",
        }),
      } as Response);

      const result = await checkForUpdates(testDir);
      expect(result.updateAvailable).toBe(false);
      expect(result.currentVersion).toBe("1.0.0");
      expect(result.latestVersion).toBe("1.0.0");
    });

    it("should be non-blocking (use timeout)", async () => {
      // Mock fetch to simulate a timeout by rejecting immediately
      global.fetch = vi.fn().mockImplementation(
        () => Promise.reject(Object.assign(new Error("Request timed out"), { name: "AbortError" }))
      );

      const start = Date.now();
      await expect(checkForUpdates(testDir, { timeoutMs: 100 })).rejects.toThrow("Request timed out");
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("createBackup", () => {
    it("should backup specified files", async () => {
      const srcFile = join(testDir, "config.json");
      await writeFile(srcFile, JSON.stringify({ test: true }));

      const backupPath = await createBackup(testDir, ["config.json"]);
      const backupFile = join(backupPath, "config.json");
      const content = await readFile(backupFile, "utf-8");

      expect(JSON.parse(content)).toEqual({ test: true });
    });

    it("should backup to .aof-backup directory", async () => {
      const srcFile = join(testDir, "data.txt");
      await writeFile(srcFile, "test data");

      const backupPath = await createBackup(testDir, ["data.txt"]);
      expect(backupPath).toContain(".aof-backup");
    });

    it("should skip missing files", async () => {
      const backupPath = await createBackup(testDir, ["missing.txt"]);
      // Should not throw, just skip the missing file
      expect(backupPath).toBeDefined();
    });

    it("should backup nested directories", async () => {
      await mkdir(join(testDir, "nested", "dir"), { recursive: true });
      await writeFile(join(testDir, "nested", "dir", "file.txt"), "nested");

      const backupPath = await createBackup(testDir, ["nested"]);
      const content = await readFile(join(backupPath, "nested", "dir", "file.txt"), "utf-8");
      expect(content).toBe("nested");
    });
  });

  describe("rollback", () => {
    it("should restore from backup", async () => {
      const configPath = join(testDir, "config.json");
      await writeFile(configPath, JSON.stringify({ version: "1.0.0" }));

      const backupPath = await createBackup(testDir, ["config.json"]);

      // Modify the file
      await writeFile(configPath, JSON.stringify({ version: "2.0.0" }));

      // Rollback
      await rollback(backupPath, testDir, ["config.json"]);

      const content = await readFile(configPath, "utf-8");
      expect(JSON.parse(content).version).toBe("1.0.0");
    });

    it("should handle multiple files", async () => {
      await writeFile(join(testDir, "file1.txt"), "v1");
      await writeFile(join(testDir, "file2.txt"), "v1");

      const backupPath = await createBackup(testDir, ["file1.txt", "file2.txt"]);

      await writeFile(join(testDir, "file1.txt"), "v2");
      await writeFile(join(testDir, "file2.txt"), "v2");

      await rollback(backupPath, testDir, ["file1.txt", "file2.txt"]);

      expect(await readFile(join(testDir, "file1.txt"), "utf-8")).toBe("v1");
      expect(await readFile(join(testDir, "file2.txt"), "utf-8")).toBe("v1");
    });

    it("should clean up backup after rollback", async () => {
      await writeFile(join(testDir, "config.json"), "original");
      const backupPath = await createBackup(testDir, ["config.json"]);

      await writeFile(join(testDir, "config.json"), "modified");
      await rollback(backupPath, testDir, ["config.json"]);

      // Backup should be cleaned up
      await expect(
        readFile(join(backupPath, "config.json"), "utf-8")
      ).rejects.toThrow();
    });

    it("should skip missing backup files", async () => {
      const backupPath = join(testDir, ".aof-backup", "test-backup");
      await mkdir(backupPath, { recursive: true });

      // Should not throw when backup doesn't contain expected files
      await expect(
        rollback(backupPath, testDir, ["missing.txt"])
      ).resolves.not.toThrow();
    });
  });

  describe("Update Policy", () => {
    it("should respect auto-check interval", async () => {
      const configPath = join(testDir, ".aof", "channel.json");
      await mkdir(join(testDir, ".aof"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          channel: "stable",
          version: "1.0.0",
          lastCheck: new Date(Date.now() - 1000).toISOString(),
          updatePolicy: {
            autoCheckIntervalMs: 3600000, // 1 hour
            mode: "notify",
          },
        })
      );

      // Should skip check if within interval
      const result = await checkForUpdates(testDir);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("checked-recently");
    });

    it("should allow manual check override", async () => {
      const configPath = join(testDir, ".aof", "channel.json");
      await mkdir(join(testDir, ".aof"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          channel: "stable",
          version: "1.0.0",
          lastCheck: new Date().toISOString(),
          updatePolicy: {
            autoCheckIntervalMs: 3600000,
            mode: "notify",
          },
        })
      );

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v1.0.0",
          name: "Release 1.0.0",
          body: "Current",
          published_at: "2026-02-01T10:00:00Z",
        }),
      } as Response);

      const result = await checkForUpdates(testDir, { force: true });
      expect(result.skipped).toBeUndefined();
    });
  });
});
