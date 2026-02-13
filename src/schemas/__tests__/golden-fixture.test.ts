/**
 * Test that the golden example fixture parses correctly
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import * as yaml from "yaml";
import { OrgChart } from "../org-chart.js";
import { lintOrgChart } from "../../org/linter.js";

describe("Golden Org Chart Fixture", () => {
  it("parses the golden example without errors", () => {
    const fixturePath = join(__dirname, "../../../tests/fixtures/golden-org-chart-v1.yaml");
    const content = readFileSync(fixturePath, "utf-8");
    const data = yaml.parse(content);
    
    const result = OrgChart.safeParse(data);
    expect(result.success).toBe(true);
    
    if (result.success) {
      expect(result.data.agents.length).toBeGreaterThan(0);
      expect(result.data.orgUnits.length).toBeGreaterThan(0);
      expect(result.data.groups.length).toBeGreaterThan(0);
      expect(result.data.memberships.length).toBeGreaterThan(0);
      expect(result.data.relationships.length).toBeGreaterThan(0);
      expect(result.data.memoryPools).toBeDefined();
    }
  });

  it("passes linting with no errors", () => {
    const fixturePath = join(__dirname, "../../../tests/fixtures/golden-org-chart-v1.yaml");
    const content = readFileSync(fixturePath, "utf-8");
    const data = yaml.parse(content);
    const chart = OrgChart.parse(data);
    
    const issues = lintOrgChart(chart);
    const errors = issues.filter(i => i.severity === "error");
    
    if (errors.length > 0) {
      console.log("Linting errors:", errors);
    }
    
    expect(errors).toHaveLength(0);
  });

  it("has correct tree structure (single root)", () => {
    const fixturePath = join(__dirname, "../../../tests/fixtures/golden-org-chart-v1.yaml");
    const content = readFileSync(fixturePath, "utf-8");
    const data = yaml.parse(content);
    const chart = OrgChart.parse(data);
    
    const roots = chart.orgUnits.filter(u => !u.parentId);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.id).toBe("company");
  });

  it("has all agents with openclawAgentId", () => {
    const fixturePath = join(__dirname, "../../../tests/fixtures/golden-org-chart-v1.yaml");
    const content = readFileSync(fixturePath, "utf-8");
    const data = yaml.parse(content);
    const chart = OrgChart.parse(data);
    
    const agentsWithoutId = chart.agents.filter(a => !a.openclawAgentId);
    expect(agentsWithoutId).toHaveLength(0);
  });

  it("has no circular escalation chains", () => {
    const fixturePath = join(__dirname, "../../../tests/fixtures/golden-org-chart-v1.yaml");
    const content = readFileSync(fixturePath, "utf-8");
    const data = yaml.parse(content);
    const chart = OrgChart.parse(data);
    
    const issues = lintOrgChart(chart);
    const circularErrors = issues.filter(i => i.rule === "no-circular-escalation");
    expect(circularErrors).toHaveLength(0);
  });

  it("has valid memory tier configurations", () => {
    const fixturePath = join(__dirname, "../../../tests/fixtures/golden-org-chart-v1.yaml");
    const content = readFileSync(fixturePath, "utf-8");
    const data = yaml.parse(content);
    const chart = OrgChart.parse(data);
    
    const issues = lintOrgChart(chart);
    const tierErrors = issues.filter(i => i.rule === "no-cold-in-warm");
    expect(tierErrors).toHaveLength(0);
  });
});
