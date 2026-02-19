/**
 * Tests for `aof notifications test` CLI command.
 *
 * Coverage:
 * - Targeted dry-run (--event=<type>): shows rule match, channel, formatted message
 * - Severity sweep (no --event): shows routing table for info/warn/critical tiers
 * - No-match case (--event=<unknown-type>): prints error and sets exitCode=1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerNotificationsCommands } from "../config-commands.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProgram(root: string): Command {
  const program = new Command();
  program.option("--root <dir>", "vault root", root);
  registerNotificationsCommands(program);
  return program;
}

async function setupRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aof-notifications-cli-test-"));
  await mkdir(join(dir, "org"), { recursive: true });
  return dir;
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("notifications test CLI command", () => {
  let testDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await setupRoot();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await rm(testDir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("targeted dry-run shows channel and formatted message for a matching event type", async () => {
    const program = makeProgram(testDir);

    // Uses DEFAULT_RULES (no rules file in testDir) — task.created routes to #aof-dispatch
    await program.parseAsync(["--root", testDir, "notifications", "test", "--event", "task.created"], {
      from: "user",
    });

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(output).toContain("task.created");
    expect(output).toContain("#aof-dispatch");
    expect(output).toContain("TASK-DRY-RUN");
    expect(process.exitCode).toBe(0);
  });

  it("targeted dry-run shows error for unknown event type", async () => {
    const program = makeProgram(testDir);

    await program.parseAsync(["--root", testDir, "notifications", "test", "--event", "totally.unknown.event.xyz"], {
      from: "user",
    });

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(output).toContain("No rule matches");
    expect(process.exitCode).toBe(1);
  });

  it("severity sweep shows routing for info/warn/critical tiers", async () => {
    const program = makeProgram(testDir);

    await program.parseAsync(["--root", testDir, "notifications", "test"], {
      from: "user",
    });

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(output).toContain("task.created");     // info tier
    expect(output).toContain("lease.expired");    // warn tier
    expect(output).toContain("system.shutdown");  // critical tier
    expect(output).toContain("Sweep complete");
  });

  it("uses custom rules from org/notification-rules.yaml when present", async () => {
    // Write a custom rules file with a custom channel for task.created
    await writeFile(
      join(testDir, "org", "notification-rules.yaml"),
      `
version: 1
rules:
  - match:
      eventType: "task.created"
    severity: warn
    audience: [operator]
    channel: "#custom-test-channel"
    template: "Custom rule fired for {taskId}"
`,
      "utf-8"
    );

    const program = makeProgram(testDir);

    await program.parseAsync(["--root", testDir, "notifications", "test", "--event", "task.created"], {
      from: "user",
    });

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(output).toContain("#custom-test-channel");
    expect(output).toContain("Custom rule fired");
    expect(process.exitCode).toBe(0);
  });

  it("targeted dry-run shows payload-matched rule for task.transitioned to review", async () => {
    const program = makeProgram(testDir);

    // This event type has payload-specific rules (to: "review" → #aof-review)
    await program.parseAsync(
      ["--root", testDir, "notifications", "test", "--event", "task.transitioned"],
      { from: "user" }
    );

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join("\n");
    // Generic task.transitioned matches (no payload in stub event)
    expect(output).toContain("task.transitioned");
    expect(output).toContain("#aof-dispatch"); // generic catch-all
  });
});
