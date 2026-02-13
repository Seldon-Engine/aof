/**
 * Host memory backend detection from OpenClaw configuration.
 * 
 * Reads ~/.openclaw/openclaw.json and detects the active memory plugin:
 * - memory-lancedb
 * - memory-core
 * - filesystem (default if no memory plugin found)
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** Supported memory backends. */
export type MemoryBackend = "memory-lancedb" | "memory-core" | "filesystem";

/** Detection result. */
export interface BackendDetectionResult {
  /** Detected backend type. */
  backend: MemoryBackend;
  /** Source location (config field path). */
  source: string;
}

/** OpenClaw config schema (partial, memory-related fields only). */
const OpenClawConfigPartial = z.object({
  plugins: z.union([
    z.object({
      slots: z.object({
        memory: z.string().optional(),
      }).optional(),
      entries: z.record(z.string(), z.object({
        enabled: z.boolean().optional(),
      })).optional(),
    }),
    z.array(z.object({
      name: z.string(),
      enabled: z.boolean().optional(),
    })),
  ]).optional(),
});

/**
 * Detect memory backend from OpenClaw config.
 * 
 * @param configPath Path to openclaw.json (defaults to ~/.openclaw/openclaw.json)
 * @returns Detection result with backend type and source
 */
export async function detectMemoryBackend(
  configPath?: string
): Promise<BackendDetectionResult> {
  const path = configPath ?? join(homedir(), ".openclaw", "openclaw.json");

  let config: unknown;
  try {
    const content = await readFile(path, "utf-8");
    config = JSON.parse(content);
  } catch (error) {
    // If config doesn't exist or can't be read, assume filesystem
    return {
      backend: "filesystem",
      source: "default (no config found)",
    };
  }

  const parsed = OpenClawConfigPartial.safeParse(config);
  if (!parsed.success) {
    return {
      backend: "filesystem",
      source: "default (invalid config)",
    };
  }

  const { plugins } = parsed.data;
  if (!plugins) {
    return {
      backend: "filesystem",
      source: "default (no plugins configured)",
    };
  }

  // Case 1: plugins.slots.memory (string)
  if (!Array.isArray(plugins) && plugins.slots?.memory) {
    const memoryPlugin = plugins.slots.memory;
    if (memoryPlugin === "memory-lancedb" || memoryPlugin === "memory-core") {
      return {
        backend: memoryPlugin,
        source: "plugins.slots.memory",
      };
    }
  }

  // Case 2: plugins.entries map (enabled check)
  if (!Array.isArray(plugins) && plugins.entries) {
    const entries = plugins.entries;
    
    // Check memory-lancedb first (precedence)
    if (entries["memory-lancedb"]?.enabled) {
      return {
        backend: "memory-lancedb",
        source: "plugins.entries.memory-lancedb",
      };
    }

    // Then check memory-core
    if (entries["memory-core"]?.enabled) {
      return {
        backend: "memory-core",
        source: "plugins.entries.memory-core",
      };
    }
  }

  // Case 3: plugins[] array entries with { name, enabled }
  if (Array.isArray(plugins)) {
    // Check memory-lancedb first (precedence)
    const lancedb = plugins.find(p => p.name === "memory-lancedb" && p.enabled !== false);
    if (lancedb) {
      return {
        backend: "memory-lancedb",
        source: "plugins[] array (memory-lancedb)",
      };
    }

    // Then check memory-core
    const memoryCore = plugins.find(p => p.name === "memory-core" && p.enabled !== false);
    if (memoryCore) {
      return {
        backend: "memory-core",
        source: "plugins[] array (memory-core)",
      };
    }
  }

  // Default: filesystem
  return {
    backend: "filesystem",
    source: "default (no memory plugin enabled)",
  };
}

/**
 * Check if a backend supports automatic inventory (file counting).
 * memory-lancedb requires manual entry count override.
 */
export function supportsAutomaticInventory(backend: MemoryBackend): boolean {
  return backend === "memory-core" || backend === "filesystem";
}
