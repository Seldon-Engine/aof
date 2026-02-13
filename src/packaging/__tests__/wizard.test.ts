import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWizard, detectOpenClaw, type WizardOptions, type WizardResult } from "../wizard.js";
import { OrgChart } from "../../schemas/org-chart.js";
import { parse as parseYaml } from "yaml";

describe("Install Wizard", () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-wizard-test-"));
    homeDir = tmpDir; // Mock home directory
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("runWizard()", () => {
    it("creates directory structure for new installation", async () => {
      const installDir = join(tmpDir, "aof-install");
      const opts: WizardOptions = {
        installDir,
        template: "minimal",
        interactive: false,
        skipOpenClaw: true,
      };

      const result = await runWizard(opts);

      expect(result.success).toBe(true);
      expect(result.installDir).toBe(installDir);
      expect(result.created.some(p => p.startsWith("tasks/"))).toBe(true);
      expect(result.created).toContain("events/");
      expect(result.created).toContain("data/");
      expect(result.created.some(p => p.startsWith("org/"))).toBe(true);

      // Verify directories exist
      await access(join(installDir, "tasks", "backlog"));
      await access(join(installDir, "tasks", "ready"));
      await access(join(installDir, "tasks", "in-progress"));
      await access(join(installDir, "tasks", "review"));
      await access(join(installDir, "tasks", "blocked"));
      await access(join(installDir, "tasks", "done"));
      await access(join(installDir, "events"));
      await access(join(installDir, "data"));
      await access(join(installDir, "org"));
    });

    it("generates minimal org chart from template", async () => {
      const installDir = join(tmpDir, "aof-minimal");
      const opts: WizardOptions = {
        installDir,
        template: "minimal",
        interactive: false,
        skipOpenClaw: true,
      };

      const result = await runWizard(opts);

      expect(result.success).toBe(true);
      expect(result.orgChartPath).toBe(join(installDir, "org", "org-chart.yaml"));

      // Verify org chart file exists and is valid
      const orgChartContent = await readFile(result.orgChartPath!, "utf-8");
      const orgChart = parseYaml(orgChartContent);
      
      const parseResult = OrgChart.safeParse(orgChart);
      expect(parseResult.success).toBe(true);

      // Minimal template should have 1 agent
      expect(parseResult.data?.agents).toHaveLength(1);
      expect(parseResult.data?.agents[0].id).toBe("main");
    });

    it("generates full org chart from template", async () => {
      const installDir = join(tmpDir, "aof-full");
      const opts: WizardOptions = {
        installDir,
        template: "full",
        interactive: false,
        skipOpenClaw: true,
      };

      const result = await runWizard(opts);

      expect(result.success).toBe(true);

      // Verify org chart is valid
      const orgChartContent = await readFile(result.orgChartPath!, "utf-8");
      const orgChart = parseYaml(orgChartContent);
      
      const parseResult = OrgChart.safeParse(orgChart);
      expect(parseResult.success).toBe(true);

      // Full template should have multiple agents and teams
      expect(parseResult.data?.agents.length).toBeGreaterThan(1);
      expect(parseResult.data?.teams.length).toBeGreaterThan(0);
    });

    it("creates .gitignore for runtime data", async () => {
      const installDir = join(tmpDir, "aof-gitignore");
      const opts: WizardOptions = {
        installDir,
        template: "minimal",
        interactive: false,
        skipOpenClaw: true,
      };

      await runWizard(opts);

      const gitignorePath = join(installDir, ".gitignore");
      const gitignoreContent = await readFile(gitignorePath, "utf-8");

      expect(gitignoreContent).toContain("events/");
      expect(gitignoreContent).toContain("data/");
      expect(gitignoreContent).toContain(".aof-state");
    });

    it("runs health check after installation", async () => {
      const installDir = join(tmpDir, "aof-health");
      const opts: WizardOptions = {
        installDir,
        template: "minimal",
        interactive: false,
        skipOpenClaw: true,
        healthCheck: true,
      };

      const result = await runWizard(opts);

      expect(result.success).toBe(true);
      expect(result.healthCheck).toBe(true);
    });

    it("detects OpenClaw workspace", async () => {
      const installDir = join(tmpDir, "aof-openclaw");
      
      // Mock OpenClaw workspace
      const openclawDir = join(tmpDir, ".openclaw");
      await mkdir(openclawDir, { recursive: true });
      await writeFile(
        join(openclawDir, "openclaw.json"),
        JSON.stringify({ version: "1.0.0" }),
        "utf-8",
      );

      const opts: WizardOptions = {
        installDir,
        template: "minimal",
        interactive: false,
        homeDir: tmpDir,
      };

      const result = await runWizard(opts);

      expect(result.success).toBe(true);
      expect(result.openclawDetected).toBe(true);
    });

    it("works without OpenClaw integration", async () => {
      const installDir = join(tmpDir, "aof-no-openclaw");
      const opts: WizardOptions = {
        installDir,
        template: "minimal",
        interactive: false,
        skipOpenClaw: true,
      };

      const result = await runWizard(opts);

      expect(result.success).toBe(true);
      expect(result.openclawDetected).toBe(false);
    });

    it("fails gracefully when directory already exists", async () => {
      const installDir = join(tmpDir, "aof-existing");
      
      // Create existing directory with org-chart.yaml
      await mkdir(join(installDir, "org"), { recursive: true });
      await writeFile(
        join(installDir, "org", "org-chart.yaml"),
        "schemaVersion: 1\nagents: []\n",
        "utf-8",
      );

      const opts: WizardOptions = {
        installDir,
        template: "minimal",
        interactive: false,
        skipOpenClaw: true,
        force: false,
      };

      await expect(runWizard(opts)).rejects.toThrow(/already exists/i);
    });

    it("overwrites existing installation with force flag", async () => {
      const installDir = join(tmpDir, "aof-force");
      
      // Create existing directory
      await mkdir(join(installDir, "org"), { recursive: true });
      await writeFile(
        join(installDir, "org", "org-chart.yaml"),
        "old content",
        "utf-8",
      );

      const opts: WizardOptions = {
        installDir,
        template: "minimal",
        interactive: false,
        skipOpenClaw: true,
        force: true,
      };

      const result = await runWizard(opts);

      expect(result.success).toBe(true);
      
      // Verify new org chart was created
      const orgChartContent = await readFile(result.orgChartPath!, "utf-8");
      expect(orgChartContent).not.toBe("old content");
    });

    it("completes in reasonable time", async () => {
      const installDir = join(tmpDir, "aof-perf");
      const opts: WizardOptions = {
        installDir,
        template: "full",
        interactive: false,
        skipOpenClaw: true,
      };

      const start = Date.now();
      await runWizard(opts);
      const elapsed = Date.now() - start;

      // Should complete in less than 5 seconds (requirement: <5 minutes)
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe("detectOpenClaw()", () => {
    it("detects OpenClaw when config exists", async () => {
      const openclawDir = join(tmpDir, ".openclaw");
      await mkdir(openclawDir, { recursive: true });
      await writeFile(
        join(openclawDir, "openclaw.json"),
        JSON.stringify({ version: "1.0.0" }),
        "utf-8",
      );

      const result = await detectOpenClaw(tmpDir);

      expect(result.detected).toBe(true);
      expect(result.configPath).toBe(join(openclawDir, "openclaw.json"));
    });

    it("returns false when OpenClaw not installed", async () => {
      const result = await detectOpenClaw(tmpDir);

      expect(result.detected).toBe(false);
      expect(result.configPath).toBeUndefined();
    });

    it("detects workspace directory", async () => {
      const openclawDir = join(tmpDir, ".openclaw");
      await mkdir(openclawDir, { recursive: true });
      await writeFile(
        join(openclawDir, "openclaw.json"),
        JSON.stringify({ version: "1.0.0" }),
        "utf-8",
      );

      const result = await detectOpenClaw(tmpDir);

      expect(result.detected).toBe(true);
    });
  });
});
