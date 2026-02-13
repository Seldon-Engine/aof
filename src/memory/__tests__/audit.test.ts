import { describe, it, expect } from "vitest";
import { auditMemoryConfig, type OpenClawConfig } from "../audit.js";
import type { MemoryConfig } from "../generator.js";

const makeExpected = (agents: Record<string, string[]>): MemoryConfig => ({
  agents: Object.fromEntries(
    Object.entries(agents).map(([id, paths]) => [id, { memorySearch: { extraPaths: paths } }])
  ),
});

const makeActual = (agents: Record<string, string[]>): OpenClawConfig => ({
  agents: Object.fromEntries(
    Object.entries(agents).map(([id, paths]) => [id, { memorySearch: { extraPaths: paths } }])
  ),
});

describe("auditMemoryConfig", () => {
  it("returns no drift when configs match", () => {
    const expected = makeExpected({
      main: ["/vault/_Core"],
      "swe-backend": ["/vault/_Core", "/vault/Runbooks"],
    });
    const actual: OpenClawConfig = {
      agents: {
        main: { memorySearch: { extraPaths: ["/vault/_Core"] } },
        "swe-backend": { memorySearch: { extraPaths: ["/vault/_Core", "/vault/Runbooks"] } },
      },
    };

    const report = auditMemoryConfig(expected, actual);

    expect(report.summary.hasDrift).toBe(false);
    expect(report.entries).toEqual([]);
  });

  it("detects missing paths", () => {
    const expected = makeExpected({
      main: ["/vault/_Core", "/vault/Architecture"],
    });
    const actual: OpenClawConfig = {
      agents: {
        main: { memorySearch: { extraPaths: ["/vault/_Core"] } },
      },
    };

    const report = auditMemoryConfig(expected, actual);

    expect(report.summary.hasDrift).toBe(true);
    expect(report.summary.missingPaths).toBe(1);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.missingPaths).toEqual(["/vault/Architecture"]);
    expect(report.entries[0]?.extraPaths).toEqual([]);
    expect(report.entries[0]?.missingConfig).toBe(false);
  });

  it("detects extra paths", () => {
    const expected = makeExpected({
      main: ["/vault/_Core"],
    });
    const actual: OpenClawConfig = {
      agents: {
        main: { memorySearch: { extraPaths: ["/vault/_Core", "/vault/Logs"] } },
      },
    };

    const report = auditMemoryConfig(expected, actual);

    expect(report.summary.hasDrift).toBe(true);
    expect(report.summary.extraPaths).toBe(1);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.missingPaths).toEqual([]);
    expect(report.entries[0]?.extraPaths).toEqual(["/vault/Logs"]);
  });

  it("detects mixed drift (missing + extra)", () => {
    const expected = makeExpected({
      main: ["/vault/_Core", "/vault/Runbooks"],
    });
    const actual: OpenClawConfig = {
      agents: {
        main: { memorySearch: { extraPaths: ["/vault/Runbooks", "/vault/Logs"] } },
      },
    };

    const report = auditMemoryConfig(expected, actual);

    expect(report.summary.hasDrift).toBe(true);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.missingPaths).toEqual(["/vault/_Core"]);
    expect(report.entries[0]?.extraPaths).toEqual(["/vault/Logs"]);
  });

  it("flags agents without any memory config", () => {
    const expected = makeExpected({
      main: ["/vault/_Core"],
    });
    const actual: OpenClawConfig = {
      agents: {},
    };

    const report = auditMemoryConfig(expected, actual);

    expect(report.summary.hasDrift).toBe(true);
    expect(report.summary.missingConfig).toBe(1);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.missingConfig).toBe(true);
    expect(report.entries[0]?.missingPaths).toEqual([]);
    expect(report.entries[0]?.extraPaths).toEqual([]);
    expect(report.entries[0]?.wildcardIssues).toEqual([]);
  });

  it("detects Projects/** wildcard paths", () => {
    const expected = makeExpected({
      main: ["/vault/_Core"],
    });
    const actual = makeActual({
      main: ["/vault/_Core", "/vault/Projects/**"],
    });

    const report = auditMemoryConfig(expected, actual);

    expect(report.summary.hasDrift).toBe(true);
    expect(report.summary.wildcardIssues).toBe(1);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.wildcardIssues).toEqual(["/vault/Projects/**"]);
  });

  it("detects Projects/* wildcard paths", () => {
    const expected = makeExpected({
      main: ["/vault/_Core"],
    });
    const actual = makeActual({
      main: ["/vault/_Core", "/vault/Projects/*"],
    });

    const report = auditMemoryConfig(expected, actual);

    expect(report.summary.hasDrift).toBe(true);
    expect(report.summary.wildcardIssues).toBe(1);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.wildcardIssues).toEqual(["/vault/Projects/*"]);
  });

  it("detects multiple wildcard patterns", () => {
    const expected = makeExpected({
      main: ["/vault/_Core"],
    });
    const actual = makeActual({
      main: ["/vault/_Core", "/vault/Projects/**", "Projects/*"],
    });

    const report = auditMemoryConfig(expected, actual);

    expect(report.summary.hasDrift).toBe(true);
    expect(report.summary.wildcardIssues).toBe(2);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.wildcardIssues).toContain("/vault/Projects/**");
    expect(report.entries[0]?.wildcardIssues).toContain("Projects/*");
  });

  it("combines wildcard issues with other drift", () => {
    const expected = makeExpected({
      main: ["/vault/_Core", "/vault/Runbooks"],
    });
    const actual = makeActual({
      main: ["/vault/Runbooks", "/vault/Projects/**", "/vault/Logs"],
    });

    const report = auditMemoryConfig(expected, actual);

    expect(report.summary.hasDrift).toBe(true);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.missingPaths).toEqual(["/vault/_Core"]);
    expect(report.entries[0]?.extraPaths).toEqual(["/vault/Logs"]);
    expect(report.entries[0]?.wildcardIssues).toEqual(["/vault/Projects/**"]);
    expect(report.summary.wildcardIssues).toBe(1);
  });
});
