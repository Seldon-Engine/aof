/**
 * Drift Report Formatter Tests
 */

import { describe, it, expect } from "vitest";
import { formatDriftReport } from "../formatter.js";
import type { DriftReport } from "../detector.js";

describe("formatDriftReport", () => {
  it("formats report with no drift", () => {
    const report: DriftReport = {
      missing: [],
      extra: [],
      mismatch: [],
      needsPermissionProfile: [],
      summary: {
        totalIssues: 0,
        hasDrift: false,
        categories: {
          missing: 0,
          extra: 0,
          mismatch: 0,
          needsPermissionProfile: 0,
        },
      },
    };

    const output = formatDriftReport(report);
    
    expect(output).toContain("✅");
    expect(output).toContain("No drift detected");
  });

  it("formats missing agents", () => {
    const report: DriftReport = {
      missing: [
        { agentId: "dev", name: "Dev Agent", openclawAgentId: "agent:dev:main" },
      ],
      extra: [],
      mismatch: [],
      needsPermissionProfile: [],
      summary: {
        totalIssues: 1,
        hasDrift: true,
        categories: { missing: 1, extra: 0, mismatch: 0, needsPermissionProfile: 0 },
      },
    };

    const output = formatDriftReport(report);
    
    expect(output).toContain("Missing");
    expect(output).toContain("dev");
    expect(output).toContain("agent:dev:main");
  });

  it("formats extra agents", () => {
    const report: DriftReport = {
      missing: [],
      extra: [
        { openclawAgentId: "agent:rogue:main", name: "Rogue Agent" },
      ],
      mismatch: [],
      needsPermissionProfile: [],
      summary: {
        totalIssues: 1,
        hasDrift: true,
        categories: { missing: 0, extra: 1, mismatch: 0, needsPermissionProfile: 0 },
      },
    };

    const output = formatDriftReport(report);
    
    expect(output).toContain("Extra");
    expect(output).toContain("agent:rogue:main");
  });

  it("formats name mismatches", () => {
    const report: DriftReport = {
      missing: [],
      extra: [],
      mismatch: [
        {
          agentId: "main",
          openclawAgentId: "agent:main:main",
          field: "name",
          orgValue: "Main Agent",
          openclawValue: "Different Name",
        },
      ],
      needsPermissionProfile: [],
      summary: {
        totalIssues: 1,
        hasDrift: true,
        categories: { missing: 0, extra: 0, mismatch: 1, needsPermissionProfile: 0 },
      },
    };

    const output = formatDriftReport(report);
    
    expect(output).toContain("Mismatch");
    expect(output).toContain("main");
    expect(output).toContain("name");
    expect(output).toContain("Main Agent");
    expect(output).toContain("Different Name");
  });

  it("formats permission profile needs", () => {
    const report: DriftReport = {
      missing: [],
      extra: [],
      mismatch: [],
      needsPermissionProfile: [
        {
          agentId: "main",
          openclawAgentId: "agent:main:main",
          reason: "memory policy defined",
        },
      ],
      summary: {
        totalIssues: 1,
        hasDrift: true,
        categories: { missing: 0, extra: 0, mismatch: 0, needsPermissionProfile: 1 },
      },
    };

    const output = formatDriftReport(report);
    
    expect(output).toContain("Permission Profile");
    expect(output).toContain("main");
    expect(output).toContain("memory policy");
  });

  it("formats complex report with multiple issues", () => {
    const report: DriftReport = {
      missing: [
        { agentId: "dev1", name: "Dev 1", openclawAgentId: "agent:dev1:main" },
        { agentId: "dev2", name: "Dev 2", openclawAgentId: "agent:dev2:main" },
      ],
      extra: [
        { openclawAgentId: "agent:rogue:main", name: "Rogue" },
      ],
      mismatch: [
        {
          agentId: "main",
          openclawAgentId: "agent:main:main",
          field: "name",
          orgValue: "Main",
          openclawValue: "Primary",
        },
      ],
      needsPermissionProfile: [
        {
          agentId: "architect",
          openclawAgentId: "agent:architect:main",
          reason: "memory policy defined, communication policy defined",
        },
      ],
      summary: {
        totalIssues: 5,
        hasDrift: true,
        categories: { missing: 2, extra: 1, mismatch: 1, needsPermissionProfile: 1 },
      },
    };

    const output = formatDriftReport(report);
    
    expect(output).toContain("5 issues");
    expect(output).toContain("Missing (2)");
    expect(output).toContain("Extra (1)");
    expect(output).toContain("Mismatch (1)");
    expect(output).toContain("Permission Profile (1)");
  });

  it("includes summary statistics", () => {
    const report: DriftReport = {
      missing: [{ agentId: "a", name: "A", openclawAgentId: "agent:a:main" }],
      extra: [{ openclawAgentId: "agent:b:main", name: "B" }],
      mismatch: [],
      needsPermissionProfile: [],
      summary: {
        totalIssues: 2,
        hasDrift: true,
        categories: { missing: 1, extra: 1, mismatch: 0, needsPermissionProfile: 0 },
      },
    };

    const output = formatDriftReport(report);
    
    expect(output).toContain("Summary");
    expect(output).toContain("2 issues");
  });
});
