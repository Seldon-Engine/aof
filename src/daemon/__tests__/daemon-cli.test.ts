/**
 * Tests for daemon CLI command formatting and exit code behavior.
 *
 * Covers formatStatusTable(), formatDegradedStatus(), and exit code semantics
 * without requiring a running daemon.
 */

import { describe, it, expect } from "vitest";
import {
  formatStatusTable,
  formatDegradedStatus,
} from "../../cli/commands/daemon.js";
import type { HealthStatus } from "../health.js";
import type { CrashRecoveryInfo } from "../../cli/commands/daemon.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHealthStatus(
  overrides?: Partial<HealthStatus> & { lastCrashRecovery?: CrashRecoveryInfo },
): HealthStatus & { lastCrashRecovery?: CrashRecoveryInfo } {
  return {
    status: "healthy",
    version: "0.1.0",
    uptime: 8130, // 2h 15m 30s
    lastPollAt: Date.now() - 5000,
    lastEventAt: Date.now() - 10000,
    taskCounts: {
      open: 3,
      ready: 1,
      inProgress: 2,
      blocked: 0,
      done: 47,
    },
    components: {
      scheduler: "running",
      store: "ok",
      eventLogger: "ok",
    },
    config: {
      dataDir: "/Users/xavier/Projects/AOF",
      pollIntervalMs: 30000,
      providersConfigured: 3,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatStatusTable
// ---------------------------------------------------------------------------

describe("formatStatusTable", () => {
  it("renders all sections with correct values", () => {
    const status = makeHealthStatus();
    const output = formatStatusTable(status, 12345);

    // Header section
    expect(output).toContain("AOF Daemon Status");
    expect(output).toContain("Status:         running (healthy)");
    expect(output).toContain("PID:            12345");
    expect(output).toContain("Uptime:         2h 15m 30s");
    expect(output).toContain("Version:        0.1.0");

    // Tasks section
    expect(output).toContain("Tasks");
    expect(output).toContain("Backlog:        3");
    expect(output).toContain("Ready:          1");
    expect(output).toContain("In-Progress:    2");
    expect(output).toContain("Blocked:        0");
    expect(output).toContain("Done:           47");

    // Components section
    expect(output).toContain("Components");
    expect(output).toContain("Scheduler:      running");
    expect(output).toContain("Store:          ok");
    expect(output).toContain("Logger:         ok");

    // Config section
    expect(output).toContain("Config");
    expect(output).toContain("Data Dir:       /Users/xavier/Projects/AOF");
    expect(output).toContain("Poll Interval:  30s");
    expect(output).toContain("Providers:      3");
  });

  it("handles zero task counts correctly", () => {
    const status = makeHealthStatus({
      taskCounts: {
        open: 0,
        ready: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      },
    });
    const output = formatStatusTable(status, 99);

    expect(output).toContain("Backlog:        0");
    expect(output).toContain("Ready:          0");
    expect(output).toContain("In-Progress:    0");
    expect(output).toContain("Blocked:        0");
    expect(output).toContain("Done:           0");
  });

  it("shows unhealthy status for degraded daemon", () => {
    const status = makeHealthStatus({ status: "unhealthy" });
    const output = formatStatusTable(status, 555);

    expect(output).toContain("Status:         running (unhealthy)");
  });

  it("shows degraded status", () => {
    const status = makeHealthStatus({ status: "degraded" });
    const output = formatStatusTable(status, 555);

    expect(output).toContain("Status:         running (degraded)");
  });

  it("includes crash recovery section when present", () => {
    const status = makeHealthStatus({
      lastCrashRecovery: {
        lastCrashAt: "2026-02-25 14:30:00",
        previousPid: 12340,
        status: "recovered",
      },
    });
    const output = formatStatusTable(status, 12345);

    expect(output).toContain("Recovery");
    expect(output).toContain("Last Crash:     2026-02-25 14:30:00");
    expect(output).toContain("Previous PID:   12340");
    expect(output).toContain("Status:         recovered");
  });

  it("omits recovery section when no crash recovery", () => {
    const status = makeHealthStatus();
    const output = formatStatusTable(status, 12345);

    expect(output).not.toContain("Recovery");
    expect(output).not.toContain("Last Crash");
    expect(output).not.toContain("Previous PID");
  });

  it("formats uptime correctly for short durations", () => {
    const status = makeHealthStatus({ uptime: 45 }); // 45 seconds
    const output = formatStatusTable(status, 1);

    expect(output).toContain("Uptime:         45s");
  });

  it("formats uptime correctly for days", () => {
    // 1d 5h 30m 15s = 86400 + 18000 + 1800 + 15 = 106215
    const status = makeHealthStatus({ uptime: 106215 });
    const output = formatStatusTable(status, 1);

    expect(output).toContain("Uptime:         1d 5h 30m 15s");
  });

  it("formats zero uptime", () => {
    const status = makeHealthStatus({ uptime: 0 });
    const output = formatStatusTable(status, 1);

    expect(output).toContain("Uptime:         0s");
  });

  it("formats poll interval from milliseconds to seconds", () => {
    const status = makeHealthStatus({
      config: {
        dataDir: "/tmp/test",
        pollIntervalMs: 60000,
        providersConfigured: 5,
      },
    });
    const output = formatStatusTable(status, 1);

    expect(output).toContain("Poll Interval:  60s");
    expect(output).toContain("Providers:      5");
  });

  it("contains horizontal separators between sections", () => {
    const status = makeHealthStatus();
    const output = formatStatusTable(status, 1);

    // Should have at least 4 separator lines (header, tasks, components, config)
    const separatorChar = "\u2500";
    const separatorLines = output.split("\n").filter((line) => line.startsWith(separatorChar));
    expect(separatorLines.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// formatDegradedStatus
// ---------------------------------------------------------------------------

describe("formatDegradedStatus", () => {
  it("shows unreachable health message with PID", () => {
    const output = formatDegradedStatus(12345);

    expect(output).toContain("AOF Daemon Status");
    expect(output).toContain("Status:         running (health endpoint unreachable)");
    expect(output).toContain("PID:            12345");
  });

  it("does not include tasks or components sections", () => {
    const output = formatDegradedStatus(1);

    expect(output).not.toContain("Tasks");
    expect(output).not.toContain("Components");
    expect(output).not.toContain("Config");
  });
});
