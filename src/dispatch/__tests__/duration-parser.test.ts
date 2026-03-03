/**
 * Tests for parseDuration — converts duration strings to milliseconds.
 *
 * Phase 13 extends support to "d" (days) unit alongside existing "m" and "h".
 *
 * @module duration-parser.test
 */

import { describe, it, expect } from "vitest";
import { parseDuration } from "../duration-parser.js";

describe("parseDuration", () => {
  // Existing behavior (m/h units)
  it("parses '30m' to 1800000ms", () => {
    expect(parseDuration("30m")).toBe(1800000);
  });

  it("parses '2h' to 7200000ms", () => {
    expect(parseDuration("2h")).toBe(7200000);
  });

  it("parses '1h' to 3600000ms", () => {
    expect(parseDuration("1h")).toBe(3600000);
  });

  // Phase 13: "d" (days) unit
  it("parses '2d' to 172800000ms (2 * 24 * 60 * 60 * 1000)", () => {
    expect(parseDuration("2d")).toBe(172800000);
  });

  it("parses '1d' to 86400000ms", () => {
    expect(parseDuration("1d")).toBe(86400000);
  });

  it("returns null for '0d' (zero rejected)", () => {
    expect(parseDuration("0d")).toBeNull();
  });

  // Rejection cases
  it("returns null for '0m' (zero rejected)", () => {
    expect(parseDuration("0m")).toBeNull();
  });

  it("returns null for '0h' (zero rejected)", () => {
    expect(parseDuration("0h")).toBeNull();
  });

  it("returns null for invalid format 'abc'", () => {
    expect(parseDuration("abc")).toBeNull();
  });

  it("returns null for unknown unit '1x'", () => {
    expect(parseDuration("1x")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseDuration("")).toBeNull();
  });
});
