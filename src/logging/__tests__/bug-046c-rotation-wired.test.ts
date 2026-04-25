/**
 * Phase 46 / Bug 1C — pino-roll wiring sanity check.
 *
 * The 172 MB daemon-stderr.log incident on 2026-04-24 was unbounded
 * pino-on-fd:2 captured by launchd. The fix is two-pronged:
 * (a) route pino through pino-roll (50 MB x 5 cap), and
 * (b) drop fd:2 from the destination chain so launchd's
 *     daemon-stderr.log only receives Node-level uncaught crashes.
 *
 * This test is a config sniff, not a behavioral test of pino-roll
 * itself (we don't re-test the library's rotation; that's pino-roll's
 * test suite). Source-level inspection avoids spawning the worker
 * thread inside vitest, which leaks workers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetConfig } from "../../config/registry.js";
import { resetLogger } from "../index.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Phase 46 / Bug 1C — pino-roll wiring", () => {
  beforeEach(() => {
    resetConfig({ core: { logLevel: "info" } });
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
    resetConfig();
  });

  it("getRootLogger uses pino.transport with pino-roll target", () => {
    const src = readFileSync(join(__dirname, "../index.ts"), "utf-8");
    expect(src).toMatch(/pino\.transport\s*\(\s*\{[^}]*target\s*:\s*["']pino-roll["']/s);
    expect(src).toMatch(/size\s*:\s*["']50m["']/);
    expect(src).toMatch(/limit\s*:\s*\{\s*count\s*:\s*5\s*\}/);
    expect(src).toMatch(/mkdir\s*:\s*true/);
  });

  it("getRootLogger does NOT use pino.destination({ fd: 2 })", () => {
    const src = readFileSync(join(__dirname, "../index.ts"), "utf-8");
    // Strip comments to avoid false positives on JSDoc that explains
    // why fd:2 is no longer a destination.
    const noComments = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
      .join("\n");
    expect(noComments).not.toMatch(/pino\.destination\s*\(\s*\{\s*fd\s*:\s*2/);
  });

  it("pino-roll is declared in package.json dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "../../../package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.["pino-roll"]).toBeDefined();
    expect(pkg.dependencies?.["pino-roll"]).toMatch(/^\^?4\./);
  });

  it("resetLogger() calls .end() on the transport (orphan-worker hazard)", () => {
    const src = readFileSync(join(__dirname, "../index.ts"), "utf-8");
    const noComments = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
      .join("\n");
    expect(noComments).toMatch(/\.end\(\)/);
  });
});
