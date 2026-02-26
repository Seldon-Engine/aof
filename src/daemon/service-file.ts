/**
 * Service file generation and installation for OS supervisors.
 *
 * Generates launchd plist (macOS) and systemd unit (Linux) files,
 * with install/uninstall helpers that write the file and start/stop the service.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceFileConfig {
  /** AOF data directory. */
  dataDir: string;
  /** Path to node binary (default: process.execPath). */
  nodeBinary?: string;
  /** Path to aof-daemon entry JS file (auto-resolved). */
  daemonBinary?: string;
  /** Additional CLI args appended after --root. */
  extraArgs?: string[];
  /** Additional environment variables merged into the service file. */
  extraEnv?: Record<string, string>;
}

export interface InstallResult {
  platform: NodeJS.Platform;
  servicePath: string;
  started: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AOF_SERVICE_LABEL = "ai.openclaw.aof";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the aof-daemon entry point.
 * Searches relative to this file (../../daemon/index.js in dist) first,
 * then falls back to the package bin entry.
 */
function resolveDaemonBinary(): string {
  // In dist layout: dist/daemon/service-file.js -> dist/daemon/index.js
  const adjacent = join(import.meta.dirname, "index.js");
  if (existsSync(adjacent)) return adjacent;
  // Fallback: traverse from package root
  const fromRoot = join(import.meta.dirname, "..", "..", "dist", "daemon", "index.js");
  if (existsSync(fromRoot)) return fromRoot;
  // Final fallback — caller must supply it
  throw new Error("Could not resolve aof-daemon binary. Pass daemonBinary in config.");
}

/**
 * Return the platform-specific path where the service file should be written.
 */
export function getServiceFilePath(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return join(homedir(), "Library", "LaunchAgents", `${AOF_SERVICE_LABEL}.plist`);
    case "linux":
      return join(homedir(), ".config", "systemd", "user", `${AOF_SERVICE_LABEL}.service`);
    default:
      throw new Error(
        `Unsupported platform "${platform}". AOF daemon install is supported on macOS (launchd) and Linux (systemd).`,
      );
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generate a launchd plist XML string for macOS.
 */
export function generateLaunchdPlist(config: ServiceFileConfig): string {
  const node = config.nodeBinary ?? process.execPath;
  const daemon = config.daemonBinary ?? resolveDaemonBinary();
  const dataDir = config.dataDir;
  const logDir = join(dataDir, "logs");

  const args = [node, daemon, "--root", dataDir, ...(config.extraArgs ?? [])];

  const envEntries: Record<string, string> = {
    AOF_ROOT: dataDir,
    ...config.extraEnv,
  };

  const envXml = Object.entries(envEntries)
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join("\n");

  const argsXml = args.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${AOF_SERVICE_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>WorkingDirectory</key>
    <string>${escapeXml(dataDir)}</string>

    <key>StandardOutPath</key>
    <string>${escapeXml(join(logDir, "daemon-stdout.log"))}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(join(logDir, "daemon-stderr.log"))}</string>

    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
</dict>
</plist>
`;
}

/**
 * Generate a systemd user unit file string for Linux.
 */
export function generateSystemdUnit(config: ServiceFileConfig): string {
  const node = config.nodeBinary ?? process.execPath;
  const daemon = config.daemonBinary ?? resolveDaemonBinary();
  const dataDir = config.dataDir;
  const logDir = join(dataDir, "logs");

  const extraArgs = config.extraArgs?.length ? " " + config.extraArgs.join(" ") : "";

  const envLines: string[] = [`Environment=AOF_ROOT=${dataDir}`];
  if (config.extraEnv) {
    for (const [k, v] of Object.entries(config.extraEnv)) {
      envLines.push(`Environment=${k}=${v}`);
    }
  }

  return `[Unit]
Description=AOF Daemon - Agentic Ops Fabric Scheduler
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env node ${daemon} --root ${dataDir}${extraArgs}
Restart=on-failure
RestartSec=5
${envLines.join("\n")}
WorkingDirectory=${dataDir}
StandardOutput=append:${join(logDir, "daemon-stdout.log")}
StandardError=append:${join(logDir, "daemon-stderr.log")}

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

/**
 * Install the AOF daemon as an OS-supervised service.
 *
 * 1. Generate the platform-appropriate service file.
 * 2. Write it to the correct location.
 * 3. Load / enable+start the service via the OS supervisor.
 */
export async function installService(config: ServiceFileConfig): Promise<InstallResult> {
  const platform = process.platform;
  const servicePath = getServiceFilePath(platform);
  const parentDir = join(servicePath, "..");

  // Ensure parent directory exists
  mkdirSync(parentDir, { recursive: true });

  // Ensure logs directory exists
  mkdirSync(join(config.dataDir, "logs"), { recursive: true });

  // Generate and write
  if (platform === "darwin") {
    const content = generateLaunchdPlist(config);
    writeFileSync(servicePath, content, "utf-8");

    // Unload first if already loaded (ignore errors)
    try {
      execSync(`launchctl bootout gui/$(id -u)/${AOF_SERVICE_LABEL} 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Not loaded yet — fine
    }
    execSync(`launchctl bootstrap gui/$(id -u) ${servicePath}`);
  } else if (platform === "linux") {
    const content = generateSystemdUnit(config);
    writeFileSync(servicePath, content, "utf-8");
    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable --now ${AOF_SERVICE_LABEL}`);
  } else {
    throw new Error(`Unsupported platform "${platform}".`);
  }

  return { platform, servicePath, started: true };
}

/**
 * Uninstall the AOF daemon service.
 *
 * 1. Stop the service via the OS supervisor.
 * 2. Remove the service file.
 * 3. Clean up socket and PID files.
 */
export async function uninstallService(dataDir?: string): Promise<void> {
  const platform = process.platform;
  const servicePath = getServiceFilePath(platform);

  if (platform === "darwin") {
    try {
      execSync(`launchctl bootout gui/$(id -u)/${AOF_SERVICE_LABEL}`, { stdio: "ignore" });
    } catch {
      // Already unloaded or not loaded
    }
  } else if (platform === "linux") {
    try {
      execSync(`systemctl --user disable --now ${AOF_SERVICE_LABEL}`, { stdio: "ignore" });
    } catch {
      // Already disabled or not loaded
    }
  }

  // Remove service file
  if (existsSync(servicePath)) {
    unlinkSync(servicePath);
  }

  // Clean up runtime files if dataDir is known
  if (dataDir) {
    const socketPath = join(dataDir, "daemon.sock");
    const pidPath = join(dataDir, "daemon.pid");
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch { /* best effort */ }
    try {
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
