/**
 * AOF Dependency Installer
 * Wraps npm commands with validation, backups, and rollback support.
 */

import { execSync } from "node:child_process";
import { access, mkdir, cp, rm, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface InstallOptions {
  cwd: string;
  useLockfile?: boolean;
  strict?: boolean;
  healthCheck?: boolean;
  preservePaths?: string[];
}

export interface InstallResult {
  success: boolean;
  command: string;
  installed: number;
  healthCheck?: boolean;
  warnings?: string[];
  backupCreated?: boolean;
  backupPath?: string;
}

export interface PackageInfo {
  name: string;
  version: string;
  type: "prod" | "dev";
}

/**
 * Install dependencies (wraps npm ci/install).
 */
export async function install(opts: InstallOptions): Promise<InstallResult> {
  const { cwd, useLockfile = true, strict = false, healthCheck = false } = opts;
  const warnings: string[] = [];

  // Validate package.json exists
  const packageJsonPath = join(cwd, "package.json");
  try {
    await access(packageJsonPath);
  } catch {
    throw new Error(`package.json not found in ${cwd}`);
  }

  // Check lockfile
  const lockfilePath = join(cwd, "package-lock.json");
  let hasLockfile = false;
  try {
    await access(lockfilePath);
    hasLockfile = true;
  } catch {
    hasLockfile = false;
  }

  // Determine command
  let command: string;
  if (useLockfile && hasLockfile) {
    command = "npm ci";
  } else if (useLockfile && !hasLockfile) {
    if (strict) {
      throw new Error("Lockfile requested but not found (strict mode)");
    }
    warnings.push("Lockfile requested but not found");
    command = "npm install";
  } else {
    command = "npm install";
  }

  // Run install
  try {
    execSync(command, {
      cwd,
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch (error) {
    throw new Error(`Installation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Count installed packages
  const installed = await countInstalledPackages(cwd);

  // Health check
  let healthCheckPassed = false;
  if (healthCheck) {
    healthCheckPassed = await performHealthCheck(cwd);
    if (!healthCheckPassed) {
      throw new Error("Health check failed after installation");
    }
  }

  return {
    success: true,
    command,
    installed,
    healthCheck: healthCheckPassed || undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Update dependencies with backup and rollback support.
 */
export async function update(opts: InstallOptions): Promise<InstallResult> {
  const { cwd, preservePaths = [] } = opts;
  let backupPath: string | undefined;

  try {
    // Create backup
    backupPath = await createBackup(cwd, preservePaths);

    // Run install/update
    const result = await install(opts);

    return {
      ...result,
      backupCreated: true,
      backupPath,
    };
  } catch (error) {
    // Rollback on failure
    if (backupPath) {
      await restoreBackup(backupPath, cwd, preservePaths);
    }
    throw error;
  }
}

/**
 * List installed packages with versions.
 */
export async function list(opts: { cwd: string }): Promise<PackageInfo[]> {
  const { cwd } = opts;
  const nodeModulesPath = join(cwd, "node_modules");

  // Check if node_modules exists
  try {
    await access(nodeModulesPath);
  } catch {
    return [];
  }

  // Read package.json to determine dep types
  const packageJsonPath = join(cwd, "package.json");
  let packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};

  try {
    const content = await readFile(packageJsonPath, "utf-8");
    packageJson = JSON.parse(content);
  } catch {
    // Continue without type info
  }

  const prodDeps = new Set(Object.keys(packageJson.dependencies ?? {}));
  const devDeps = new Set(Object.keys(packageJson.devDependencies ?? {}));

  // List top-level packages
  const entries = await readdir(nodeModulesPath, { withFileTypes: true });
  const packages: PackageInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    // Handle scoped packages (@org/package)
    if (entry.name.startsWith("@")) {
      const scopedPackages = await readdir(join(nodeModulesPath, entry.name), { withFileTypes: true });
      for (const scopedEntry of scopedPackages) {
        if (!scopedEntry.isDirectory()) continue;
        const fullName = `${entry.name}/${scopedEntry.name}`;
        const version = await getPackageVersion(join(nodeModulesPath, entry.name, scopedEntry.name));
        if (version) {
          packages.push({
            name: fullName,
            version,
            type: devDeps.has(fullName) ? "dev" : "prod",
          });
        }
      }
    } else {
      const version = await getPackageVersion(join(nodeModulesPath, entry.name));
      if (version) {
        packages.push({
          name: entry.name,
          version,
          type: devDeps.has(entry.name) ? "dev" : "prod",
        });
      }
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Helper functions ---

async function countInstalledPackages(cwd: string): Promise<number> {
  const nodeModulesPath = join(cwd, "node_modules");
  try {
    const entries = await readdir(nodeModulesPath, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      if (entry.name.startsWith("@")) {
        const scopedPackages = await readdir(join(nodeModulesPath, entry.name));
        count += scopedPackages.length;
      } else {
        count++;
      }
    }

    return count;
  } catch {
    return 0;
  }
}

async function performHealthCheck(cwd: string): Promise<boolean> {
  try {
    // Verify node_modules exists
    await access(join(cwd, "node_modules"));

    // Try requiring a known dependency
    const packageJsonPath = join(cwd, "package.json");
    const content = await readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(content);
    const deps = packageJson.dependencies ?? {};

    // Check first dependency exists
    const firstDep = Object.keys(deps)[0];
    if (firstDep) {
      await access(join(cwd, "node_modules", firstDep));
    }

    return true;
  } catch {
    return false;
  }
}

async function createBackup(cwd: string, preservePaths: string[]): Promise<string> {
  const backupPath = join(tmpdir(), `aof-backup-${Date.now()}`);
  await mkdir(backupPath, { recursive: true });

  for (const path of preservePaths) {
    const sourcePath = join(cwd, path);
    const targetPath = join(backupPath, path);

    try {
      await access(sourcePath);
      await cp(sourcePath, targetPath, { recursive: true });
    } catch {
      // Path doesn't exist, skip
    }
  }

  return backupPath;
}

async function restoreBackup(backupPath: string, cwd: string, preservePaths: string[]): Promise<void> {
  for (const path of preservePaths) {
    const sourcePath = join(backupPath, path);
    const targetPath = join(cwd, path);

    try {
      await access(sourcePath);
      await rm(targetPath, { recursive: true, force: true });
      await cp(sourcePath, targetPath, { recursive: true });
    } catch {
      // Backup doesn't exist for this path, skip
    }
  }

  // Clean up backup
  await rm(backupPath, { recursive: true, force: true });
}

async function getPackageVersion(packagePath: string): Promise<string | null> {
  try {
    const packageJsonPath = join(packagePath, "package.json");
    const content = await readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(content);
    return packageJson.version ?? null;
  } catch {
    return null;
  }
}
