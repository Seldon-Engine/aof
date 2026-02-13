/**
 * Tests for curation policy schema and parser.
 */

import { describe, it, expect } from "vitest";
import {
  CurationPolicy,
  parseDuration,
  normalizeThresholds,
  validatePolicy,
  getPoolThresholds,
  getPoolGuardrails,
} from "../curation-policy.js";

describe("parseDuration", () => {
  it("parses days correctly", () => {
    expect(parseDuration("1d")).toBe(86400000);
    expect(parseDuration("7d")).toBe(7 * 86400000);
    expect(parseDuration("30d")).toBe(30 * 86400000);
  });

  it("parses hours correctly", () => {
    expect(parseDuration("1h")).toBe(3600000);
    expect(parseDuration("2h")).toBe(2 * 3600000);
    expect(parseDuration("24h")).toBe(24 * 3600000);
  });

  it("parses minutes correctly", () => {
    expect(parseDuration("1m")).toBe(60000);
    expect(parseDuration("15m")).toBe(15 * 60000);
    expect(parseDuration("60m")).toBe(60 * 60000);
  });

  it("throws on invalid format", () => {
    expect(() => parseDuration("30")).toThrow("Invalid duration format");
    expect(() => parseDuration("30s")).toThrow("Invalid duration format");
    expect(() => parseDuration("abc")).toThrow("Invalid duration format");
    expect(() => parseDuration("")).toThrow("Invalid duration format");
  });
});

describe("normalizeThresholds", () => {
  it("sorts thresholds by maxEntries ascending", () => {
    const thresholds = [
      { maxEntries: 1000, interval: "7d" },
      { maxEntries: 100, interval: "30d" },
      { maxEntries: 500, interval: "14d" },
    ];

    const normalized = normalizeThresholds(thresholds);
    expect(normalized[0]?.maxEntries).toBe(100);
    expect(normalized[1]?.maxEntries).toBe(500);
    expect(normalized[2]?.maxEntries).toBe(1000);
  });

  it("places null maxEntries last", () => {
    const thresholds = [
      { maxEntries: null, interval: "1d" },
      { maxEntries: 100, interval: "30d" },
      { maxEntries: 500, interval: "14d" },
    ];

    const normalized = normalizeThresholds(thresholds);
    expect(normalized[0]?.maxEntries).toBe(100);
    expect(normalized[1]?.maxEntries).toBe(500);
    expect(normalized[2]?.maxEntries).toBe(null);
  });

  it("handles all null maxEntries", () => {
    const thresholds = [
      { maxEntries: null, interval: "1d" },
      { maxEntries: null, interval: "7d" },
    ];

    const normalized = normalizeThresholds(thresholds);
    expect(normalized.length).toBe(2);
    expect(normalized[0]?.maxEntries).toBe(null);
    expect(normalized[1]?.maxEntries).toBe(null);
  });

  it("does not mutate original array", () => {
    const thresholds = [
      { maxEntries: 1000, interval: "7d" },
      { maxEntries: 100, interval: "30d" },
    ];

    const original = [...thresholds];
    normalizeThresholds(thresholds);
    expect(thresholds).toEqual(original);
  });
});

describe("CurationPolicy schema", () => {
  it("parses valid minimal policy", () => {
    const raw = {
      schemaVersion: 1,
      thresholds: [
        { maxEntries: 1000, interval: "7d" },
      ],
    };

    const policy = CurationPolicy.parse(raw);
    expect(policy.schemaVersion).toBe(1);
    expect(policy.thresholds).toHaveLength(1);
    expect(policy.strategy).toBe("prune");
  });

  it("parses policy with guardrails", () => {
    const raw = {
      schemaVersion: 1,
      thresholds: [{ maxEntries: 1000, interval: "7d" }],
      guardrails: {
        preserveTags: ["important", "pinned"],
        preserveRecent: "7d",
        minEntries: 50,
        maxDeletePerRun: 100,
      },
    };

    const policy = CurationPolicy.parse(raw);
    expect(policy.guardrails.preserveTags).toEqual(["important", "pinned"]);
    expect(policy.guardrails.preserveRecent).toBe("7d");
    expect(policy.guardrails.minEntries).toBe(50);
    expect(policy.guardrails.maxDeletePerRun).toBe(100);
  });

  it("parses policy with pool overrides", () => {
    const raw = {
      schemaVersion: 1,
      thresholds: [{ maxEntries: 1000, interval: "7d" }],
      poolOverrides: [
        {
          poolId: "hot",
          thresholds: [{ maxEntries: 500, interval: "1d" }],
        },
        {
          poolId: "warm-ops",
          disabled: true,
        },
      ],
    };

    const policy = CurationPolicy.parse(raw);
    expect(policy.poolOverrides).toHaveLength(2);
    expect(policy.poolOverrides[0]?.poolId).toBe("hot");
    expect(policy.poolOverrides[1]?.disabled).toBe(true);
  });

  it("rejects invalid schema version", () => {
    const raw = {
      schemaVersion: 2,
      thresholds: [{ maxEntries: 1000, interval: "7d" }],
    };

    expect(() => CurationPolicy.parse(raw)).toThrow();
  });

  it("rejects empty thresholds", () => {
    const raw = {
      schemaVersion: 1,
      thresholds: [],
    };

    expect(() => CurationPolicy.parse(raw)).toThrow();
  });

  it("rejects invalid interval format", () => {
    const raw = {
      schemaVersion: 1,
      thresholds: [{ maxEntries: 1000, interval: "7days" }],
    };

    expect(() => CurationPolicy.parse(raw)).toThrow();
  });
});

describe("validatePolicy", () => {
  it("accepts valid ascending thresholds", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [
        { maxEntries: 100, interval: "30d" },
        { maxEntries: 500, interval: "7d" },
        { maxEntries: 1000, interval: "1d" },
      ],
    });

    expect(() => validatePolicy(policy)).not.toThrow();
  });

  it("rejects non-ascending thresholds", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [
        { maxEntries: 500, interval: "7d" },
        { maxEntries: 100, interval: "30d" },
      ],
    });

    expect(() => validatePolicy(policy)).toThrow("ascending");
  });

  it("accepts null maxEntries as final threshold", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [
        { maxEntries: 100, interval: "30d" },
        { maxEntries: null, interval: "1d" },
      ],
    });

    expect(() => validatePolicy(policy)).not.toThrow();
  });

  it("rejects invalid guardrail duration at parse time", () => {
    expect(() =>
      CurationPolicy.parse({
        schemaVersion: 1,
        thresholds: [{ maxEntries: 1000, interval: "7d" }],
        guardrails: {
          preserveRecent: "invalid",
        },
      })
    ).toThrow();
  });

  it("validates pool override thresholds", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [{ maxEntries: 1000, interval: "7d" }],
      poolOverrides: [
        {
          poolId: "test",
          thresholds: [
            { maxEntries: 500, interval: "7d" },
            { maxEntries: 100, interval: "30d" },
          ],
        },
      ],
    });

    expect(() => validatePolicy(policy)).toThrow("ascending");
  });
});

describe("getPoolThresholds", () => {
  it("returns global thresholds when no override exists", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [
        { maxEntries: 100, interval: "30d" },
        { maxEntries: 1000, interval: "7d" },
      ],
    });

    const thresholds = getPoolThresholds(policy, "hot");
    expect(thresholds).toHaveLength(2);
    expect(thresholds[0]?.maxEntries).toBe(100);
  });

  it("returns override thresholds when present", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [{ maxEntries: 1000, interval: "7d" }],
      poolOverrides: [
        {
          poolId: "hot",
          thresholds: [{ maxEntries: 500, interval: "1d" }],
        },
      ],
    });

    const thresholds = getPoolThresholds(policy, "hot");
    expect(thresholds).toHaveLength(1);
    expect(thresholds[0]?.maxEntries).toBe(500);
  });

  it("returns empty array when pool is disabled", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [{ maxEntries: 1000, interval: "7d" }],
      poolOverrides: [
        {
          poolId: "hot",
          disabled: true,
        },
      ],
    });

    const thresholds = getPoolThresholds(policy, "hot");
    expect(thresholds).toHaveLength(0);
  });

  it("normalizes returned thresholds", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [
        { maxEntries: 1000, interval: "7d" },
        { maxEntries: 100, interval: "30d" },
      ],
    });

    const thresholds = getPoolThresholds(policy, "hot");
    expect(thresholds[0]?.maxEntries).toBe(100);
    expect(thresholds[1]?.maxEntries).toBe(1000);
  });
});

describe("getPoolGuardrails", () => {
  it("returns global guardrails when no override exists", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [{ maxEntries: 1000, interval: "7d" }],
      guardrails: {
        preserveTags: ["important"],
        minEntries: 50,
      },
    });

    const guardrails = getPoolGuardrails(policy, "hot");
    expect(guardrails.preserveTags).toEqual(["important"]);
    expect(guardrails.minEntries).toBe(50);
  });

  it("merges override guardrails with global", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [{ maxEntries: 1000, interval: "7d" }],
      guardrails: {
        preserveTags: ["important"],
        minEntries: 50,
      },
      poolOverrides: [
        {
          poolId: "hot",
          guardrails: {
            preserveTags: ["pinned"],
            preserveRecent: "7d",
          },
        },
      ],
    });

    const guardrails = getPoolGuardrails(policy, "hot");
    expect(guardrails.preserveTags).toEqual(["important", "pinned"]);
    expect(guardrails.preserveRecent).toBe("7d");
    expect(guardrails.minEntries).toBe(50);
  });

  it("override values take precedence", () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [{ maxEntries: 1000, interval: "7d" }],
      guardrails: {
        minEntries: 50,
        maxDeletePerRun: 100,
      },
      poolOverrides: [
        {
          poolId: "hot",
          guardrails: {
            minEntries: 100,
            maxDeletePerRun: 50,
          },
        },
      ],
    });

    const guardrails = getPoolGuardrails(policy, "hot");
    expect(guardrails.minEntries).toBe(100);
    expect(guardrails.maxDeletePerRun).toBe(50);
  });
});
