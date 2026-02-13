/**
 * AOF OpenClaw Ejection
 * Cleanly removes OpenClaw integration while preserving AOF standalone functionality.
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { homedir } from "node:os";

export interface DetectionResult {
  integrated: boolean;
  configPath?: string;
}

export interface EjectionOptions {
  /** Path to OpenClaw config file */
  openclawConfigPath: string;
  /** Home directory (for resolving paths) */
  homeDir?: string;
}

export interface EjectionResult {
  success: boolean;
  pluginRemoved?: boolean;
  backupCreated?: boolean;
  backupPath?: string;
  validationPassed?: boolean;
  alreadyEjected?: boolean;
  warnings?: string[];
  error?: string;
}

interface OpenClawConfig {
  version?: string;
  plugins?: Array<{
    name: string;
    path: string;
    enabled: boolean;
    config?: Record<string, unknown>;
  }>;
  memory?: {
    pools?: Array<{
      name: string;
      path: string;
    }>;
  };
  [key: string]: unknown;
}

/**
 * Detect if AOF is currently integrated with OpenClaw.
 */
export async function detectOpenClawIntegration(
  configPath: string,
): Promise<DetectionResult> {
  try {
    const configContent = await readFile(configPath, "utf-8");
    const config = JSON.parse(configContent) as OpenClawConfig;

    const aofPlugin = config.plugins?.find((p) => p.name === "aof");

    return {
      integrated: aofPlugin !== undefined,
      configPath: aofPlugin ? configPath : undefined,
    };
  } catch {
    return {
      integrated: false,
    };
  }
}

/**
 * Eject AOF from OpenClaw integration.
 * Removes the AOF plugin registration while preserving all other OpenClaw configuration.
 */
export async function ejectFromOpenClaw(
  opts: EjectionOptions,
): Promise<EjectionResult> {
  const {
    openclawConfigPath,
    homeDir = homedir(),
  } = opts;

  const warnings: string[] = [];

  try {
    // Step 1: Read existing config
    let configContent: string;
    try {
      configContent = await readFile(openclawConfigPath, "utf-8");
    } catch (error) {
      return {
        success: false,
        error: `OpenClaw config not found at ${openclawConfigPath}`,
      };
    }

    // Step 2: Parse config
    let config: OpenClawConfig;
    try {
      config = JSON.parse(configContent) as OpenClawConfig;
    } catch (error) {
      return {
        success: false,
        error: `Invalid JSON in OpenClaw config: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Ensure plugins array exists
    if (!Array.isArray(config.plugins)) {
      config.plugins = [];
    }

    // Step 3: Check if AOF plugin exists
    const aofPluginIndex = config.plugins.findIndex((p) => p.name === "aof");
    if (aofPluginIndex === -1) {
      return {
        success: true,
        alreadyEjected: true,
        pluginRemoved: false,
        warnings: ["AOF plugin is not registered. No changes made."],
      };
    }

    // Step 4: Create backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${openclawConfigPath}.backup-${timestamp}`;
    await copyFile(openclawConfigPath, backupPath);

    // Step 5: Remove AOF plugin
    config.plugins.splice(aofPluginIndex, 1);

    // Step 6: Validate config structure
    let validationPassed = false;
    try {
      // Basic validation: ensure required fields are present
      if (config.version && Array.isArray(config.plugins)) {
        validationPassed = true;
      }
    } catch {
      validationPassed = false;
    }

    if (!validationPassed) {
      return {
        success: false,
        error: "Config validation failed after modification",
      };
    }

    // Step 7: Write updated config
    const updatedContent = JSON.stringify(config, null, 2);
    await writeFile(openclawConfigPath, updatedContent, "utf-8");

    // Add standard warnings
    warnings.push("OpenClaw Gateway restart recommended to deactivate plugin");

    return {
      success: true,
      pluginRemoved: true,
      backupCreated: true,
      backupPath,
      validationPassed,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: `Ejection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
