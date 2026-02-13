/**
 * Tests for host memory backend detection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectMemoryBackend, supportsAutomaticInventory } from "../host-detection.js";

describe("detectMemoryBackend", () => {
  let testDir: string;
  let configPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `aof-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    configPath = join(testDir, "openclaw.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns filesystem when config does not exist", async () => {
    const result = await detectMemoryBackend(join(testDir, "missing.json"));
    expect(result.backend).toBe("filesystem");
    expect(result.source).toContain("no config found");
  });

  it("returns filesystem when config is invalid JSON", async () => {
    await writeFile(configPath, "invalid json", "utf-8");
    const result = await detectMemoryBackend(configPath);
    expect(result.backend).toBe("filesystem");
    expect(result.source).toContain("no config found");
  });

  it("returns filesystem when no plugins configured", async () => {
    await writeFile(configPath, JSON.stringify({}), "utf-8");
    const result = await detectMemoryBackend(configPath);
    expect(result.backend).toBe("filesystem");
    expect(result.source).toContain("no plugins configured");
  });

  describe("plugins.slots.memory", () => {
    it("detects memory-lancedb from slots", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            slots: {
              memory: "memory-lancedb",
            },
          },
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-lancedb");
      expect(result.source).toBe("plugins.slots.memory");
    });

    it("detects memory-core from slots", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            slots: {
              memory: "memory-core",
            },
          },
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-core");
      expect(result.source).toBe("plugins.slots.memory");
    });

    it("returns filesystem for unknown slot plugin", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            slots: {
              memory: "unknown-plugin",
            },
          },
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("filesystem");
    });
  });

  describe("plugins.entries", () => {
    it("detects memory-lancedb from entries map", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              "memory-lancedb": { enabled: true },
            },
          },
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-lancedb");
      expect(result.source).toBe("plugins.entries.memory-lancedb");
    });

    it("detects memory-core from entries map", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              "memory-core": { enabled: true },
            },
          },
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-core");
      expect(result.source).toBe("plugins.entries.memory-core");
    });

    it("prefers memory-lancedb over memory-core", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              "memory-lancedb": { enabled: true },
              "memory-core": { enabled: true },
            },
          },
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-lancedb");
    });

    it("ignores disabled plugins", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              "memory-lancedb": { enabled: false },
              "memory-core": { enabled: true },
            },
          },
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-core");
    });

    it("returns filesystem when no memory plugin is enabled", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              "memory-lancedb": { enabled: false },
              "memory-core": { enabled: false },
            },
          },
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("filesystem");
    });
  });

  describe("plugins[] array", () => {
    it("detects memory-lancedb from array", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [
            { name: "memory-lancedb", enabled: true },
          ],
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-lancedb");
      expect(result.source).toContain("plugins[] array");
    });

    it("detects memory-core from array", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [
            { name: "memory-core", enabled: true },
          ],
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-core");
      expect(result.source).toContain("plugins[] array");
    });

    it("prefers memory-lancedb over memory-core", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [
            { name: "memory-core", enabled: true },
            { name: "memory-lancedb", enabled: true },
          ],
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-lancedb");
    });

    it("ignores disabled plugins", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [
            { name: "memory-lancedb", enabled: false },
            { name: "memory-core", enabled: true },
          ],
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-core");
    });

    it("treats missing enabled as true", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [
            { name: "memory-lancedb" },
          ],
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("memory-lancedb");
    });

    it("returns filesystem when no memory plugin in array", async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [
            { name: "other-plugin", enabled: true },
          ],
        }),
        "utf-8"
      );

      const result = await detectMemoryBackend(configPath);
      expect(result.backend).toBe("filesystem");
    });
  });
});

describe("supportsAutomaticInventory", () => {
  it("returns true for memory-core", () => {
    expect(supportsAutomaticInventory("memory-core")).toBe(true);
  });

  it("returns true for filesystem", () => {
    expect(supportsAutomaticInventory("filesystem")).toBe(true);
  });

  it("returns false for memory-lancedb", () => {
    expect(supportsAutomaticInventory("memory-lancedb")).toBe(false);
  });
});
