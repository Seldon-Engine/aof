import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { getConfigValue, setConfigValue } from "../manager.js";

describe("Config manager", () => {
  let tmpDir: string;
  let configPath: string;

  const sampleOrgChart = {
    schemaVersion: 1,
    agents: [
      { id: "swe-backend", name: "Backend Dev", active: true },
      { id: "swe-frontend", name: "Frontend Dev", active: true },
    ],
    teams: [
      { id: "swe", name: "Software Engineering" },
    ],
    routing: [],
    metadata: {},
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-config-test-"));
    configPath = join(tmpDir, "org-chart.yaml");
    await writeFile(configPath, stringifyYaml(sampleOrgChart), "utf-8");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("getConfigValue", () => {
    it("gets simple top-level value", async () => {
      const value = await getConfigValue(configPath, "schemaVersion");
      expect(value).toBe(1);
    });

    it("gets nested value by id lookup in agents array", async () => {
      const value = await getConfigValue(configPath, "agents.swe-backend.name");
      expect(value).toBe("Backend Dev");
    });

    it("gets nested value in teams array", async () => {
      const value = await getConfigValue(configPath, "teams.swe.name");
      expect(value).toBe("Software Engineering");
    });

    it("returns undefined for missing agent", async () => {
      const value = await getConfigValue(configPath, "agents.nonexistent.active");
      expect(value).toBeUndefined();
    });
  });

  describe("setConfigValue", () => {
    it("sets simple top-level value", async () => {
      const result = await setConfigValue(configPath, "schemaVersion", "2", false);
      expect(result.change.newValue).toBe(2);
      expect(result.issues.length).toBeGreaterThan(0); // Schema validation will fail
    });

    it("sets nested value by id lookup", async () => {
      const result = await setConfigValue(configPath, "agents.swe-backend.active", "false", false);
      expect(result.change.oldValue).toBe(true);
      expect(result.change.newValue).toBe(false);
      
      const newValue = await getConfigValue(configPath, "agents.swe-backend.active");
      expect(newValue).toBe(false);
    });

    it("creates new agent entry when missing", async () => {
      await setConfigValue(configPath, "agents.swe-new.id", "swe-new", false);
      await setConfigValue(configPath, "agents.swe-new.name", "New Agent", false);
      await setConfigValue(configPath, "agents.swe-new.active", "true", false);
      
      const newName = await getConfigValue(configPath, "agents.swe-new.name");
      expect(newName).toBe("New Agent");
    });

    it("respects dry-run mode", async () => {
      const result = await setConfigValue(configPath, "agents.swe-backend.active", "false", true);
      expect(result.change.newValue).toBe(false);
      
      // Value should not have changed
      const value = await getConfigValue(configPath, "agents.swe-backend.active");
      expect(value).toBe(true);
    });
  });
});
