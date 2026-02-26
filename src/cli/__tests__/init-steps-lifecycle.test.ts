/**
 * Unit tests for init-steps-lifecycle.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WizardState } from "../init-steps.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), access: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock("yaml", () => ({ parse: vi.fn() }));
vi.mock("../../schemas/org-chart.js", () => ({ OrgChart: { safeParse: vi.fn() } }));
vi.mock("../../packaging/openclaw-cli.js", () => ({
  isAofInAllowList: vi.fn(),
  openclawConfigGet: vi.fn(),
  execFileAsync: vi.fn(),
}));
vi.mock("../../daemon/service-file.js", () => ({ installService: vi.fn() }));

import { confirm } from "@inquirer/prompts";
import { readFile, access } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { OrgChart } from "../../schemas/org-chart.js";
import { isAofInAllowList, openclawConfigGet, execFileAsync } from "../../packaging/openclaw-cli.js";
import { installService } from "../../daemon/service-file.js";
import { runLintStep, runRestartStep, runDaemonStep } from "../init-steps-lifecycle.js";

function makeState(): WizardState {
  return {
    pluginRegistered: false, addedToAllowList: false, syncCompleted: false,
    memoryConfigured: false, skillInstalled: false, skillsWired: false,
    orgChartValid: false, gatewayRestarted: false, daemonRunning: false,
    warnings: [], skipped: [],
  };
}

// ── runLintStep ───────────────────────────────────────────────────────────────

describe("runLintStep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1: org chart absent → orgChartValid=true, skipped entry added", async () => {
    vi.mocked(access).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(isAofInAllowList).mockResolvedValue(true);
    const state = makeState();
    await runLintStep(state, false);
    expect(state.orgChartValid).toBe(true);
    expect(state.skipped).toContain("Org chart lint (no org chart found)");
    expect(state.warnings).toHaveLength(0);
  });

  it("2: org chart present + valid → orgChartValid=true, no warnings", async () => {
    vi.mocked(access).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue("name: test" as never);
    vi.mocked(parseYaml).mockReturnValue({ name: "test" });
    vi.mocked(OrgChart.safeParse).mockReturnValue({ success: true, data: {} } as never);
    vi.mocked(isAofInAllowList).mockResolvedValue(true);
    const state = makeState();
    await runLintStep(state, false);
    expect(state.orgChartValid).toBe(true);
    expect(state.warnings).toHaveLength(0);
  });

  it("3: org chart present + invalid → orgChartValid=false, warning added", async () => {
    vi.mocked(access).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue("bad: data" as never);
    vi.mocked(parseYaml).mockReturnValue({ bad: "data" });
    vi.mocked(OrgChart.safeParse).mockReturnValue({
      success: false,
      error: { issues: [{ path: ["name"], message: "Required" }] },
    } as never);
    vi.mocked(isAofInAllowList).mockResolvedValue(true);
    const state = makeState();
    await runLintStep(state, false);
    expect(state.orgChartValid).toBe(false);
    expect(state.warnings.some((w) => w.includes("validation errors"))).toBe(true);
  });

  it("4: AOF not in allow list → warning added", async () => {
    vi.mocked(access).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(isAofInAllowList).mockResolvedValue(false);
    const state = makeState();
    await runLintStep(state, false);
    expect(state.warnings.some((w) => w.includes("allow list"))).toBe(true);
  });

  it("5: AOF in allow list → no allow-list warning", async () => {
    vi.mocked(access).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(isAofInAllowList).mockResolvedValue(true);
    const state = makeState();
    await runLintStep(state, false);
    expect(state.warnings.every((w) => !w.includes("allow list"))).toBe(true);
  });
});

// ── runRestartStep ────────────────────────────────────────────────────────────

describe("runRestartStep", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("6: user declines → skipped entry, gatewayRestarted=false", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    const state = makeState();
    await runRestartStep(state, false);
    expect(state.gatewayRestarted).toBe(false);
    expect(state.skipped).toContain("Gateway restart");
  });

  it("7: restart + health poll succeeds → gatewayRestarted=true", async () => {
    vi.mocked(execFileAsync).mockResolvedValue({ stdout: "", stderr: "" } as never);
    vi.mocked(openclawConfigGet).mockResolvedValue("http://127.0.0.1:3000");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const state = makeState();
    await runRestartStep(state, true);
    expect(state.gatewayRestarted).toBe(true);
    expect(state.warnings).toHaveLength(0);
  });

  it("8: execFileAsync throws → warning added, exits early", async () => {
    vi.mocked(execFileAsync).mockRejectedValue(new Error("spawn failed"));
    const state = makeState();
    await runRestartStep(state, true);
    expect(state.gatewayRestarted).toBe(false);
    expect(state.warnings.some((w) => w.includes("Gateway restart failed"))).toBe(true);
  });

  it("9: health poll all attempts fail → warning, gatewayRestarted=false", async () => {
    vi.mocked(execFileAsync).mockResolvedValue({ stdout: "", stderr: "" } as never);
    vi.mocked(openclawConfigGet).mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("refused")));
    vi.useFakeTimers();
    const state = makeState();
    const p = runRestartStep(state, true);
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    expect(state.gatewayRestarted).toBe(false);
    expect(state.warnings.some((w) => w.includes("did not respond") || w.includes("Gateway restart failed"))).toBe(true);
  });
});

// ── runDaemonStep ─────────────────────────────────────────────────────────────

describe("runDaemonStep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("10: PID file present + process running → skip, daemonRunning=true", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("12345" as never);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    const state = makeState();
    await runDaemonStep(state, false);
    expect(state.daemonRunning).toBe(true);
    expect(state.skipped).toContain("AOF daemon start (already running)");
    killSpy.mockRestore();
  });

  it("11: PID file absent + user confirms → calls installService, daemonRunning=true", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(installService).mockResolvedValue({ platform: "darwin", servicePath: "/tmp/test.plist", started: true });
    const state = makeState();
    await runDaemonStep(state, false);
    expect(installService).toHaveBeenCalled();
    expect(state.daemonRunning).toBe(true);
  });

  it("12: user declines start → skipped entry, daemonRunning=false", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(confirm).mockResolvedValue(false);
    const state = makeState();
    await runDaemonStep(state, false);
    expect(state.daemonRunning).toBe(false);
    expect(state.skipped).toContain("AOF daemon start");
  });

  it("13: installService throws → warning added, daemonRunning=false", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(installService).mockRejectedValue(new Error("port in use"));
    const state = makeState();
    await runDaemonStep(state, true);
    expect(state.daemonRunning).toBe(false);
    expect(state.warnings.some((w) => w.includes("Daemon install failed"))).toBe(true);
  });
});
