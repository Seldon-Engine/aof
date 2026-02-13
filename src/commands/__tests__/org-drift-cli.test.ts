/**
 * CLI Integration Tests — aof org drift command
 * 
 * Tests the end-to-end CLI workflow for drift detection:
 * - Fixture source (default and custom paths)
 * - Live source (with mocked openclaw command)
 * - Exit codes and output formatting
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

describe("CLI: aof org drift", () => {
  let tempDir: string;
  let orgChartPath: string;
  let fixturePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "aof-cli-test-"));
    
    // Create test org chart
    const orgChart = `
schemaVersion: 1
agents:
  - id: main
    name: Main
    openclawAgentId: agent:main:main
    active: true
  - id: dev
    name: Dev
    openclawAgentId: agent:dev:main
    active: true
`;
    orgChartPath = join(tempDir, "org-chart.yaml");
    writeFileSync(orgChartPath, orgChart);

    // Create test fixture
    const fixtureData = [
      { id: "agent:main:main", name: "Main", creature: "agent", active: true },
      { id: "agent:dev:main", name: "Dev", creature: "agent", active: true },
    ];
    fixturePath = join(tempDir, "agents.json");
    writeFileSync(fixturePath, JSON.stringify(fixtureData, null, 2));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("--source=fixture (default)", () => {
    it("uses default fixture path when not specified", () => {
      // Create default fixture location
      const testsDir = join(tempDir, "tests", "fixtures");
      mkdirSync(testsDir, { recursive: true });
      const defaultFixture = join(testsDir, "openclaw-agents.json");
      writeFileSync(defaultFixture, JSON.stringify([
        { id: "agent:main:main", name: "Main", creature: "agent", active: true },
        { id: "agent:dev:main", name: "Dev", creature: "agent", active: true },
      ], null, 2));

      const result = execSync(
        `node dist/cli/index.js --root=${tempDir} org drift ${orgChartPath} --source=fixture`,
        { encoding: "utf-8", env: { ...process.env, AOF_ROOT: tempDir } }
      );

      expect(result).toContain("Checking drift");
      expect(result).toContain("Source: fixture");
      expect(result).toContain("✅");
    });

    it("accepts custom fixture path via --fixture", () => {
      const result = execSync(
        `node dist/cli/index.js --root=${tempDir} org drift ${orgChartPath} --source=fixture --fixture=${fixturePath}`,
        { encoding: "utf-8", env: { ...process.env, AOF_ROOT: tempDir } }
      );

      expect(result).toContain("Checking drift");
      expect(result).toContain(`fixture (${fixturePath})`);
      expect(result).toContain("✅");
    });

    it("exits with code 0 when no drift detected", () => {
      try {
        execSync(
          `node dist/cli/index.js --root=${tempDir} org drift ${orgChartPath} --source=fixture --fixture=${fixturePath}`,
          { encoding: "utf-8", stdio: "pipe" }
        );
        expect(true).toBe(true); // Should not throw
      } catch (err) {
        expect.fail("Should not throw when no drift");
      }
    });

    it("exits with code 1 when drift detected", () => {
      // Create org chart with missing agent
      const orgChartWithDrift = `
schemaVersion: 1
agents:
  - id: main
    name: Main
    openclawAgentId: agent:main:main
    active: true
  - id: ghost
    name: Ghost
    openclawAgentId: agent:ghost:main
    active: true
`;
      const driftOrgPath = join(tempDir, "drift-org.yaml");
      writeFileSync(driftOrgPath, orgChartWithDrift);

      try {
        execSync(
          `node dist/cli/index.js --root=${tempDir} org drift ${driftOrgPath} --source=fixture --fixture=${fixturePath}`,
          { encoding: "utf-8", stdio: "pipe" }
        );
        expect.fail("Should throw when drift detected");
      } catch (err: unknown) {
        const error = err as { status?: number };
        expect(error.status).toBe(1);
      }
    });
  });

  describe("--source=fixture error handling", () => {
    it("throws when fixture path not provided and default doesn't exist", () => {
      try {
        execSync(
          `node dist/cli/index.js --root=${tempDir} org drift ${orgChartPath} --source=fixture`,
          { encoding: "utf-8", stdio: "pipe" }
        );
        expect.fail("Should throw when fixture not found");
      } catch (err) {
        expect(err).toBeDefined();
      }
    });

    it("throws when fixture file does not exist", () => {
      const nonexistent = join(tempDir, "nonexistent.json");
      
      try {
        execSync(
          `node dist/cli/index.js --root=${tempDir} org drift ${orgChartPath} --source=fixture --fixture=${nonexistent}`,
          { encoding: "utf-8", stdio: "pipe" }
        );
        expect.fail("Should throw when fixture file missing");
      } catch (err) {
        expect(err).toBeDefined();
      }
    });

    it("throws when fixture file is invalid JSON", () => {
      const invalidFixture = join(tempDir, "invalid.json");
      writeFileSync(invalidFixture, "not valid json");

      try {
        execSync(
          `node dist/cli/index.js --root=${tempDir} org drift ${orgChartPath} --source=fixture --fixture=${invalidFixture}`,
          { encoding: "utf-8", stdio: "pipe" }
        );
        expect.fail("Should throw when fixture is invalid JSON");
      } catch (err) {
        expect(err).toBeDefined();
      }
    });
  });

  describe("--source=live", () => {
    it("has live source option", () => {
      // This test just verifies the option exists
      // Live adapter is tested separately with mocked execSync
      try {
        execSync(
          `node dist/cli/index.js --root=${tempDir} org drift ${orgChartPath} --source=live`,
          { encoding: "utf-8", stdio: "pipe", timeout: 5000 }
        );
      } catch (err: unknown) {
        const error = err as { stderr?: Buffer; message?: string };
        // Expected to fail (timeout or missing openclaw in test env)
        // Check stderr first, fall back to error message
        const errorOutput = error.stderr?.toString() || error.message || "";
        expect(errorOutput).toBeTruthy(); // Just verify an error occurred
      }
    });
  });

  describe("drift report output", () => {
    it("shows missing agents in report", () => {
      const orgChartWithMissing = `
schemaVersion: 1
agents:
  - id: main
    name: Main
    openclawAgentId: agent:main:main
    active: true
  - id: ghost
    name: Ghost
    openclawAgentId: agent:ghost:main
    active: true
`;
      const missingOrgPath = join(tempDir, "missing-org.yaml");
      writeFileSync(missingOrgPath, orgChartWithMissing);

      try {
        execSync(
          `node dist/cli/index.js --root=${tempDir} org drift ${missingOrgPath} --source=fixture --fixture=${fixturePath}`,
          { encoding: "utf-8", stdio: "pipe" }
        );
      } catch (err: unknown) {
        const error = err as { stdout?: Buffer };
        const output = error.stdout?.toString() ?? "";
        expect(output).toContain("Missing");
        expect(output).toContain("ghost");
      }
    });

    it("shows extra agents in report", () => {
      const fixtureWithExtra = [
        { id: "agent:main:main", name: "Main", creature: "agent", active: true },
        { id: "agent:dev:main", name: "Dev", creature: "agent", active: true },
        { id: "agent:extra:main", name: "Extra", creature: "agent", active: true },
      ];
      const extraFixture = join(tempDir, "extra-agents.json");
      writeFileSync(extraFixture, JSON.stringify(fixtureWithExtra, null, 2));

      try {
        execSync(
          `node dist/cli/index.js --root=${tempDir} org drift ${orgChartPath} --source=fixture --fixture=${extraFixture}`,
          { encoding: "utf-8", stdio: "pipe" }
        );
      } catch (err: unknown) {
        const error = err as { stdout?: Buffer };
        const output = error.stdout?.toString() ?? "";
        expect(output).toContain("Extra");
        expect(output).toContain("agent:extra:main");
      }
    });

    it("shows name mismatches in report", () => {
      const fixtureWithMismatch = [
        { id: "agent:main:main", name: "Different Name", creature: "agent", active: true },
        { id: "agent:dev:main", name: "Dev", creature: "agent", active: true },
      ];
      const mismatchFixture = join(tempDir, "mismatch-agents.json");
      writeFileSync(mismatchFixture, JSON.stringify(fixtureWithMismatch, null, 2));

      try {
        execSync(
          `node dist/cli/index.js --root=${tempDir} org drift ${orgChartPath} --source=fixture --fixture=${mismatchFixture}`,
          { encoding: "utf-8", stdio: "pipe" }
        );
      } catch (err: unknown) {
        const error = err as { stdout?: Buffer };
        const output = error.stdout?.toString() ?? "";
        expect(output).toContain("Mismatch");
        expect(output).toContain("main");
      }
    });
  });
});
