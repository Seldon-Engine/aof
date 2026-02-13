/**
 * Tests for context budget tracking.
 */

import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateChars,
  evaluateBudget,
  type BudgetUsage,
  type ContextBudgetPolicy,
} from "../budget.js";
import type { ContextBundle } from "../assembler.js";

describe("estimateTokens", () => {
  it("estimates tokens using 4-char-per-token heuristic", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBe(2); // 5 chars / 4 = 1.25 -> ceil = 2
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 -> ceil = 3
    expect(estimateTokens("a".repeat(400))).toBe(100); // 400 / 4 = 100
    expect(estimateTokens("a".repeat(401))).toBe(101); // 401 / 4 = 100.25 -> ceil = 101
  });

  it("handles empty strings", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles unicode correctly (counts chars not bytes)", () => {
    expect(estimateTokens("🔥")).toBe(1); // 1 char / 4 = 0.25 -> ceil = 1
    expect(estimateTokens("你好世界")).toBe(1); // 4 chars / 4 = 1
  });
});

describe("estimateChars", () => {
  it("converts tokens to chars using 4-char-per-token heuristic", () => {
    expect(estimateChars(0)).toBe(0);
    expect(estimateChars(1)).toBe(4);
    expect(estimateChars(100)).toBe(400);
    expect(estimateChars(1000)).toBe(4000);
  });
});

describe("evaluateBudget", () => {
  const mockBundle = (totalChars: number): ContextBundle => ({
    summary: "x".repeat(totalChars),
    manifest: {
      version: "v1",
      taskId: "TEST-001",
      layers: { seed: [], optional: [], deep: [] },
    },
    totalChars,
    sources: [],
  });

  it("returns 'ok' when no policy is provided", () => {
    const bundle = mockBundle(1000);
    const result = evaluateBudget(bundle);

    expect(result).toEqual({
      taskId: "TEST-001",
      totalChars: 1000,
      estimatedTokens: 250,
      policy: undefined,
      status: "ok",
    });
  });

  it("returns 'ok' when within target budget", () => {
    const bundle = mockBundle(500);
    const policy: ContextBudgetPolicy = {
      target: 1000,
      warn: 2000,
      critical: 3000,
    };

    const result = evaluateBudget(bundle, policy);
    expect(result.status).toBe("ok");
    expect(result.totalChars).toBe(500);
    expect(result.estimatedTokens).toBe(125);
    expect(result.policy).toEqual(policy);
  });

  it("returns 'warn' when between target and warn threshold", () => {
    const bundle = mockBundle(1500);
    const policy: ContextBudgetPolicy = {
      target: 1000,
      warn: 2000,
      critical: 3000,
    };

    const result = evaluateBudget(bundle, policy);
    expect(result.status).toBe("warn");
  });

  it("returns 'critical' when between warn and critical threshold", () => {
    const bundle = mockBundle(2500);
    const policy: ContextBudgetPolicy = {
      target: 1000,
      warn: 2000,
      critical: 3000,
    };

    const result = evaluateBudget(bundle, policy);
    expect(result.status).toBe("critical");
  });

  it("returns 'over' when exceeding critical threshold", () => {
    const bundle = mockBundle(3500);
    const policy: ContextBudgetPolicy = {
      target: 1000,
      warn: 2000,
      critical: 3000,
    };

    const result = evaluateBudget(bundle, policy);
    expect(result.status).toBe("over");
  });

  it("handles edge case at exactly target", () => {
    const bundle = mockBundle(1000);
    const policy: ContextBudgetPolicy = {
      target: 1000,
      warn: 2000,
      critical: 3000,
    };

    const result = evaluateBudget(bundle, policy);
    expect(result.status).toBe("ok");
  });

  it("handles edge case at exactly warn threshold", () => {
    const bundle = mockBundle(2000);
    const policy: ContextBudgetPolicy = {
      target: 1000,
      warn: 2000,
      critical: 3000,
    };

    const result = evaluateBudget(bundle, policy);
    expect(result.status).toBe("warn");
  });

  it("handles edge case at exactly critical threshold", () => {
    const bundle = mockBundle(3000);
    const policy: ContextBudgetPolicy = {
      target: 1000,
      warn: 2000,
      critical: 3000,
    };

    const result = evaluateBudget(bundle, policy);
    expect(result.status).toBe("critical");
  });

  it("extracts taskId from bundle manifest", () => {
    const bundle = mockBundle(100);
    bundle.manifest.taskId = "CUSTOM-123";

    const result = evaluateBudget(bundle);
    expect(result.taskId).toBe("CUSTOM-123");
  });
});
