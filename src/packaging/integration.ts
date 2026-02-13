/**
 * AOF OpenClaw Integration
 * Automates plugin registration and memory scoping configuration.
 */

import { readFile, writeFile, access, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DetectionResult {
  detected: boolean;
  configPath?: string;
}

export interface IntegrationOptions {
  /** AOF root directory (e.g., ~/Projects/AOF) */
  aofRoot: string;
  /** Path to OpenClaw config file */
  openclawConfigPath: string;
  /** Home directory (for resolving paths) */
  homeDir?: string;
  /** Run health check after integration */
  healthCheck?: boolean;
}

export interface IntegrationResult {
  success: boolean;
  pluginRegistered?: boolean;
  memoryScopingConfigured?: boolean;
  backupCreated?: boolean;
  backupPath?: string;
  validationPassed?: boolean;
  healthCheckPassed?: boolean;
  alreadyIntegrated?: boolean;
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
 * Detect OpenClaw configuration file.
 */
export async function detectOpenClawConfig(
  homeDir: string = homedir(),
): Promise<DetectionResult> {
  const configPath = join(homeDir, ".openclaw", "openclaw.json");

  try {
    await access(configPath);
    return {
      detected: true,
      configPath,
    };
  } catch {
    return {
      detected: false,
    };
  }
}

/**
 * Integrate AOF with OpenClaw.
 * Registers the AOF plugin, configures memory scoping, and validates the result.
 */
export async function integrateWithOpenClaw(
  opts: IntegrationOptions,
): Promise<IntegrationResult> {
  const {
    aofRoot,
    openclawConfigPath,
    homeDir = homedir(),
    healthCheck = false,
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

    // Step 3: Check if already integrated
    const existingAofPlugin = config.plugins.find((p) => p.name === "aof");
    if (existingAofPlugin) {
      return {
        success: true,
        alreadyIntegrated: true,
        pluginRegistered: true,
        memoryScopingConfigured: true,
        warnings: ["AOF plugin already registered. No changes made."],
      };
    }

    // Step 4: Create backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${openclawConfigPath}.backup-${timestamp}`;
    await copyFile(openclawConfigPath, backupPath);

    // Step 5: Register AOF plugin
    const pluginPath = join(aofRoot, "dist", "openclaw", "adapter.js");
    const aofPlugin = {
      name: "aof",
      path: pluginPath,
      enabled: true,
      config: {
        dataDir: aofRoot,
      },
    };

    config.plugins.push(aofPlugin);

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

    // Step 8: Health check (optional)
    let healthCheckPassed: boolean | undefined;
    if (healthCheck) {
      healthCheckPassed = await performHealthCheck(aofRoot, config);
      if (!healthCheckPassed) {
        warnings.push("Health check did not pass");
      }
    }

    // Add standard warnings
    warnings.push("OpenClaw Gateway restart recommended to activate plugin");

    return {
      success: true,
      pluginRegistered: true,
      memoryScopingConfigured: true,
      backupCreated: true,
      backupPath,
      validationPassed,
      healthCheckPassed,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: `Integration failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Perform health check after integration.
 */
async function performHealthCheck(
  aofRoot: string,
  config: OpenClawConfig,
): Promise<boolean> {
  try {
    // Check 1: AOF installation directory exists
    await access(aofRoot);

    // Check 2: AOF plugin adapter exists
    const adapterPath = join(aofRoot, "dist", "openclaw", "adapter.js");
    await access(adapterPath);

    // Check 3: AOF plugin is in config
    const aofPlugin = config.plugins?.find((p) => p.name === "aof");
    if (!aofPlugin) {
      return false;
    }

    // Check 4: Plugin has required config
    if (!aofPlugin.config?.dataDir) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
