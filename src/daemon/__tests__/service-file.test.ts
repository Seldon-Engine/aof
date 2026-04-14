import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  getServiceFilePath,
  launchctlInstallIdempotent,
  AOF_SERVICE_LABEL,
  type LaunchctlOps,
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

  it("includes ExecStart with node binary, daemon binary, --root, and dataDir", () => {
    const cfg = makeConfig({ dataDir: "/home/user/.aof" });
    const unit = generateSystemdUnit(cfg);
    expect(unit).toContain(
      "ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/aof/dist/daemon/index.js --root /home/user/.aof",
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

// ---------------------------------------------------------------------------
// launchctlInstallIdempotent — bug-2026-04-14-daemon-install-use-kickstart
// ---------------------------------------------------------------------------

describe("launchctlInstallIdempotent", () => {
  /**
   * Construct a mock `LaunchctlOps` with a scripted `isLoaded` sequence so we
   * can simulate service state transitions across the steps of the install.
   */
  function makeOps(loadedSequence: boolean[]): {
    ops: LaunchctlOps;
    calls: string[];
  } {
    const calls: string[] = [];
    let i = 0;
    const ops: LaunchctlOps = {
      isLoaded: () => {
        const v = loadedSequence[Math.min(i++, loadedSequence.length - 1)] ?? false;
        calls.push(`isLoaded=${v}`);
        return v;
      },
      exec: (cmd) => {
        calls.push(cmd);
      },
      sleep: async () => {
        calls.push("sleep");
      },
    };
    return { ops, calls };
  }

  it("bootstraps + kickstarts when service is not loaded", async () => {
    // Sequence: bootout probe skipped (no isLoaded before bootout), then the
    // bootout throws nothing in mock, wait loop asks isLoaded → false (exits
    // immediately), post-wait isLoaded → false → bootstrap, then kickstart.
    const { ops, calls } = makeOps([false, false]);

    await launchctlInstallIdempotent("/tmp/aof.plist", {
      label: "ai.openclaw.aof",
      uid: 501,
      ops,
    });

    expect(calls).toEqual([
      "launchctl bootout gui/501/ai.openclaw.aof",
      "isLoaded=false",
      "isLoaded=false",
      "launchctl bootstrap gui/501 /tmp/aof.plist",
      "launchctl kickstart -k gui/501/ai.openclaw.aof",
    ]);
  });

  it("bootstraps after bootout settles when service was loaded", async () => {
    // bootout runs (no probe before), wait-loop sees loaded=true once, sleeps,
    // then loaded=false; post-wait probe returns false → bootstrap + kickstart.
    const { ops, calls } = makeOps([true, false, false]);

    await launchctlInstallIdempotent("/tmp/aof.plist", {
      label: "ai.openclaw.aof",
      uid: 501,
      ops,
    });

    expect(calls).toEqual([
      "launchctl bootout gui/501/ai.openclaw.aof",
      "isLoaded=true",
      "sleep",
      "isLoaded=false",
      "isLoaded=false",
      "launchctl bootstrap gui/501 /tmp/aof.plist",
      "launchctl kickstart -k gui/501/ai.openclaw.aof",
    ]);
  });

  it("skips bootstrap when bootout is a silent no-op (EIO guard)", async () => {
    // Regression: bootout didn't actually unload (e.g. re-bootstrapped by the
    // OS). Wait-loop times out with service still loaded. bootstrap MUST be
    // skipped to avoid `launchctl bootstrap: 5: Input/output error`.
    // kickstart -k still runs — it restarts the already-loaded service.
    const loadedForever = Array(20).fill(true);
    const { ops, calls } = makeOps(loadedForever);

    await launchctlInstallIdempotent("/tmp/aof.plist", {
      label: "ai.openclaw.aof",
      uid: 501,
      ops,
    });

    const execs = calls.filter((c) => c.startsWith("launchctl"));
    // Expect: bootout, kickstart. NO bootstrap.
    expect(execs).toEqual([
      "launchctl bootout gui/501/ai.openclaw.aof",
      "launchctl kickstart -k gui/501/ai.openclaw.aof",
    ]);
    expect(execs.some((c) => c.includes("bootstrap"))).toBe(false);

    // Wait loop should have slept 10 times (5s cap at 500ms each).
    expect(calls.filter((c) => c === "sleep").length).toBe(10);
  });

  it("swallows errors from the best-effort bootout", async () => {
    const calls: string[] = [];
    const ops: LaunchctlOps = {
      isLoaded: () => {
        calls.push("isLoaded=false");
        return false;
      },
      exec: (cmd) => {
        if (cmd.includes("bootout")) {
          throw new Error("not loaded");
        }
        calls.push(cmd);
      },
      sleep: async () => {},
    };

    await expect(
      launchctlInstallIdempotent("/tmp/aof.plist", { label: "ai.openclaw.aof", uid: 501, ops }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      "isLoaded=false",
      "isLoaded=false",
      "launchctl bootstrap gui/501 /tmp/aof.plist",
      "launchctl kickstart -k gui/501/ai.openclaw.aof",
    ]);
  });
});
