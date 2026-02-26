import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  getServiceFilePath,
  AOF_SERVICE_LABEL,
  type ServiceFileConfig,
} from "../service-file.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ServiceFileConfig> = {}): ServiceFileConfig {
  return {
    dataDir: "/tmp/aof-test-data",
    nodeBinary: "/usr/local/bin/node",
    daemonBinary: "/usr/local/lib/node_modules/aof/dist/daemon/index.js",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateLaunchdPlist
// ---------------------------------------------------------------------------

describe("generateLaunchdPlist", () => {
  it("produces valid XML with correct Label", () => {
    const plist = generateLaunchdPlist(makeConfig());
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain(`<string>${AOF_SERVICE_LABEL}</string>`);
  });

  it("includes ProgramArguments with node, daemon binary, --root, and dataDir", () => {
    const cfg = makeConfig({ dataDir: "/home/user/.aof" });
    const plist = generateLaunchdPlist(cfg);
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/usr/local/lib/node_modules/aof/dist/daemon/index.js</string>");
    expect(plist).toContain("<string>--root</string>");
    expect(plist).toContain("<string>/home/user/.aof</string>");
  });

  it("sets KeepAlive to true", () => {
    const plist = generateLaunchdPlist(makeConfig());
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
  });

  it("sets RunAtLoad to true", () => {
    const plist = generateLaunchdPlist(makeConfig());
    expect(plist).toContain("<key>RunAtLoad</key>");
    // RunAtLoad <true/> follows the key
    const runAtLoadIdx = plist.indexOf("<key>RunAtLoad</key>");
    const trueIdx = plist.indexOf("<true/>", runAtLoadIdx);
    expect(trueIdx).toBeGreaterThan(runAtLoadIdx);
  });

  it("sets ThrottleInterval to 5", () => {
    const plist = generateLaunchdPlist(makeConfig());
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>5</integer>");
  });

  it("includes stdout and stderr log paths under dataDir/logs", () => {
    const cfg = makeConfig({ dataDir: "/data/aof" });
    const plist = generateLaunchdPlist(cfg);
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain(join("/data/aof", "logs", "daemon-stdout.log"));
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain(join("/data/aof", "logs", "daemon-stderr.log"));
  });

  it("includes AOF_ROOT in EnvironmentVariables", () => {
    const cfg = makeConfig({ dataDir: "/data/aof" });
    const plist = generateLaunchdPlist(cfg);
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>AOF_ROOT</key>");
    expect(plist).toContain("<string>/data/aof</string>");
  });

  it("sets WorkingDirectory to dataDir", () => {
    const cfg = makeConfig({ dataDir: "/data/aof" });
    const plist = generateLaunchdPlist(cfg);
    expect(plist).toContain("<key>WorkingDirectory</key>");
    // WorkingDirectory value follows the key
    const wdIdx = plist.indexOf("<key>WorkingDirectory</key>");
    const valIdx = plist.indexOf("<string>/data/aof</string>", wdIdx);
    expect(valIdx).toBeGreaterThan(wdIdx);
  });

  it("includes extraArgs in ProgramArguments", () => {
    const cfg = makeConfig({ extraArgs: ["--dry-run", "--interval", "5000"] });
    const plist = generateLaunchdPlist(cfg);
    expect(plist).toContain("<string>--dry-run</string>");
    expect(plist).toContain("<string>--interval</string>");
    expect(plist).toContain("<string>5000</string>");
  });

  it("includes extraEnv in EnvironmentVariables", () => {
    const cfg = makeConfig({ extraEnv: { DEBUG: "aof:*", CUSTOM_VAR: "hello" } });
    const plist = generateLaunchdPlist(cfg);
    expect(plist).toContain("<key>DEBUG</key>");
    expect(plist).toContain("<string>aof:*</string>");
    expect(plist).toContain("<key>CUSTOM_VAR</key>");
    expect(plist).toContain("<string>hello</string>");
  });

  it("escapes XML special characters in paths", () => {
    const cfg = makeConfig({ dataDir: "/data/aof & <test>" });
    const plist = generateLaunchdPlist(cfg);
    expect(plist).toContain("&amp;");
    expect(plist).toContain("&lt;test&gt;");
    // Should NOT contain raw & or < in value positions
    expect(plist).not.toContain("<string>/data/aof & <test></string>");
  });
});

// ---------------------------------------------------------------------------
// generateSystemdUnit
// ---------------------------------------------------------------------------

describe("generateSystemdUnit", () => {
  it("produces a valid unit file with [Unit], [Service], [Install] sections", () => {
    const unit = generateSystemdUnit(makeConfig());
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("sets Description", () => {
    const unit = generateSystemdUnit(makeConfig());
    expect(unit).toContain("Description=AOF Daemon - Agentic Ops Fabric Scheduler");
  });

  it("sets After=network.target", () => {
    const unit = generateSystemdUnit(makeConfig());
    expect(unit).toContain("After=network.target");
  });

  it("includes ExecStart with /usr/bin/env node, daemon binary, --root, and dataDir", () => {
    const cfg = makeConfig({ dataDir: "/home/user/.aof" });
    const unit = generateSystemdUnit(cfg);
    expect(unit).toContain(
      "ExecStart=/usr/bin/env node /usr/local/lib/node_modules/aof/dist/daemon/index.js --root /home/user/.aof",
    );
  });

  it("sets Restart=on-failure", () => {
    const unit = generateSystemdUnit(makeConfig());
    expect(unit).toContain("Restart=on-failure");
  });

  it("sets RestartSec=5", () => {
    const unit = generateSystemdUnit(makeConfig());
    expect(unit).toContain("RestartSec=5");
  });

  it("sets Type=simple", () => {
    const unit = generateSystemdUnit(makeConfig());
    expect(unit).toContain("Type=simple");
  });

  it("includes AOF_ROOT environment variable", () => {
    const cfg = makeConfig({ dataDir: "/data/aof" });
    const unit = generateSystemdUnit(cfg);
    expect(unit).toContain("Environment=AOF_ROOT=/data/aof");
  });

  it("sets WorkingDirectory to dataDir", () => {
    const cfg = makeConfig({ dataDir: "/data/aof" });
    const unit = generateSystemdUnit(cfg);
    expect(unit).toContain("WorkingDirectory=/data/aof");
  });

  it("includes stdout and stderr log paths", () => {
    const cfg = makeConfig({ dataDir: "/data/aof" });
    const unit = generateSystemdUnit(cfg);
    expect(unit).toContain(`StandardOutput=append:${join("/data/aof", "logs", "daemon-stdout.log")}`);
    expect(unit).toContain(`StandardError=append:${join("/data/aof", "logs", "daemon-stderr.log")}`);
  });

  it("sets WantedBy=default.target", () => {
    const unit = generateSystemdUnit(makeConfig());
    expect(unit).toContain("WantedBy=default.target");
  });

  it("includes extraArgs in ExecStart", () => {
    const cfg = makeConfig({ extraArgs: ["--dry-run"] });
    const unit = generateSystemdUnit(cfg);
    expect(unit).toMatch(/ExecStart=.*--dry-run/);
  });

  it("includes extraEnv as additional Environment lines", () => {
    const cfg = makeConfig({ extraEnv: { DEBUG: "aof:*" } });
    const unit = generateSystemdUnit(cfg);
    expect(unit).toContain("Environment=DEBUG=aof:*");
  });
});

// ---------------------------------------------------------------------------
// getServiceFilePath
// ---------------------------------------------------------------------------

describe("getServiceFilePath", () => {
  it("returns LaunchAgents path for darwin", () => {
    const path = getServiceFilePath("darwin");
    expect(path).toBe(join(homedir(), "Library", "LaunchAgents", `${AOF_SERVICE_LABEL}.plist`));
  });

  it("returns systemd user path for linux", () => {
    const path = getServiceFilePath("linux");
    expect(path).toBe(join(homedir(), ".config", "systemd", "user", `${AOF_SERVICE_LABEL}.service`));
  });

  it("throws for win32", () => {
    expect(() => getServiceFilePath("win32")).toThrow(/Unsupported platform/);
  });

  it("throws for unsupported platforms", () => {
    expect(() => getServiceFilePath("freebsd" as NodeJS.Platform)).toThrow(/Unsupported platform/);
  });
});
