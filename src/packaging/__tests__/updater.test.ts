import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selfUpdate, rollbackUpdate, type UpdateOptions, type UpdateHooks } from "../updater.js";

describe("Self-Update Engine", () => {
  let tmpDir: string;
  let aofRoot: string;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-updater-test-"));
    aofRoot = join(tmpDir, "aof");

    // Create AOF directory structure
    await mkdir(aofRoot, { recursive: true });
    await mkdir(join(aofRoot, ".aof"), { recursive: true });
    await mkdir(join(aofRoot, "config"), { recursive: true });
    await mkdir(join(aofRoot, "data"), { recursive: true });

    // Create channel config
    await writeFile(
      join(aofRoot, ".aof", "channel.json"),
      JSON.stringify({
        channel: "stable",
        version: "1.0.0",
      }, null, 2),
    );

    // Create sample config/data files
    await writeFile(join(aofRoot, "config", "settings.json"), JSON.stringify({ test: true }));
    await writeFile(join(aofRoot, "data", "state.json"), JSON.stringify({ count: 42 }));

    // Mock fetch
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("selfUpdate()", () => {
    it("downloads and installs new version successfully", async () => {
      // Mock tarball response with ReadableStream body
      const tarballData = Buffer.from("fake tarball data");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(tarballData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
        arrayBuffer: async () => tarballData.buffer,
      });

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        preservePaths: ["config", "data"],
      };

      const result = await selfUpdate(opts);

      expect(result.success).toBe(true);
      expect(result.version).toBe("1.1.0");
      expect(result.backupCreated).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/aof-1.1.0.tar.gz",
        expect.any(Object),
      );

      // Verify version updated in config
      const config = JSON.parse(
        await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
      );
      expect(config.version).toBe("1.1.0");
    });

    it("preserves config and data during update", async () => {
      const tarballData = Buffer.from("fake tarball data");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(tarballData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
        arrayBuffer: async () => tarballData.buffer,
      });

      const originalConfig = await readFile(join(aofRoot, "config", "settings.json"), "utf-8");
      const originalData = await readFile(join(aofRoot, "data", "state.json"), "utf-8");

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        preservePaths: ["config", "data"],
      };

      await selfUpdate(opts);

      // Verify config and data preserved
      const newConfig = await readFile(join(aofRoot, "config", "settings.json"), "utf-8");
      const newData = await readFile(join(aofRoot, "data", "state.json"), "utf-8");

      expect(newConfig).toBe(originalConfig);
      expect(newData).toBe(originalData);
    });

    it("executes pre-update hooks", async () => {
      const tarballData = Buffer.from("fake tarball data");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(tarballData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
        arrayBuffer: async () => tarballData.buffer,
      });

      const preUpdateMock = vi.fn().mockResolvedValue(undefined);
      const hooks: UpdateHooks = {
        preUpdate: preUpdateMock,
      };

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        hooks,
      };

      await selfUpdate(opts);

      expect(preUpdateMock).toHaveBeenCalledWith({
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        aofRoot,
      });
    });

    it("executes post-update hooks", async () => {
      const tarballData = Buffer.from("fake tarball data");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(tarballData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
        arrayBuffer: async () => tarballData.buffer,
      });

      const postUpdateMock = vi.fn().mockResolvedValue(undefined);
      const hooks: UpdateHooks = {
        postUpdate: postUpdateMock,
      };

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        hooks,
      };

      await selfUpdate(opts);

      expect(postUpdateMock).toHaveBeenCalledWith({
        previousVersion: "1.0.0",
        currentVersion: "1.1.0",
        aofRoot,
      });
    });

    it("rolls back on download failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        preservePaths: ["config", "data"],
      };

      await expect(selfUpdate(opts)).rejects.toThrow(/download failed/i);

      // Verify original version still in config
      const config = JSON.parse(
        await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
      );
      expect(config.version).toBe("1.0.0");
    });

    it("rolls back on health check failure", async () => {
      const tarballData = Buffer.from("fake tarball data");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(tarballData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
        arrayBuffer: async () => tarballData.buffer,
      });

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        healthCheck: async () => false, // Fail health check
      };

      await expect(selfUpdate(opts)).rejects.toThrow(/health check failed/i);

      // Verify rollback restored original version
      const config = JSON.parse(
        await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
      );
      expect(config.version).toBe("1.0.0");
    });

    it("respects timeout", async () => {
      // Mock fetch that respects the abort signal
      mockFetch.mockImplementationOnce((url: string, options: { signal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
          // Never resolve unless aborted
        });
      });

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        timeoutMs: 100,
      };

      await expect(selfUpdate(opts)).rejects.toThrow(/timeout|timed out/i);
    });
  });

  describe("rollbackUpdate()", () => {
    it("restores previous version from backup", async () => {
      // Simulate a successful update first
      const backupPath = join(aofRoot, ".aof-backup", "backup-test");
      await mkdir(join(backupPath, ".aof"), { recursive: true });
      await mkdir(join(backupPath, "config"), { recursive: true });
      await writeFile(
        join(backupPath, ".aof", "channel.json"),
        JSON.stringify({ channel: "stable", version: "1.0.0" }, null, 2),
      );
      await writeFile(
        join(backupPath, "config", "settings.json"),
        JSON.stringify({ original: true }),
      );

      // Update current version
      await writeFile(
        join(aofRoot, ".aof", "channel.json"),
        JSON.stringify({ channel: "stable", version: "1.1.0" }, null, 2),
      );
      await writeFile(
        join(aofRoot, "config", "settings.json"),
        JSON.stringify({ modified: true }),
      );

      // Rollback
      const result = await rollbackUpdate({
        aofRoot,
        backupPath,
        preservePaths: ["config", ".aof"],
      });

      expect(result.success).toBe(true);
      expect(result.restoredVersion).toBe("1.0.0");

      // Verify version restored
      const config = JSON.parse(
        await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
      );
      expect(config.version).toBe("1.0.0");

      // Verify config restored
      const settings = JSON.parse(
        await readFile(join(aofRoot, "config", "settings.json"), "utf-8"),
      );
      expect(settings.original).toBe(true);
    });

    it("fails when backup doesn't exist", async () => {
      const nonExistentBackup = join(aofRoot, ".aof-backup", "nonexistent");

      await expect(
        rollbackUpdate({
          aofRoot,
          backupPath: nonExistentBackup,
          preservePaths: ["config"],
        }),
      ).rejects.toThrow(/backup not found/i);
    });
  });
});
