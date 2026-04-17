/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers decision D-14: migration 007 installs the `aof-daemon` OS service
 * (launchd on macOS, systemd on Linux) on `aof setup --auto --upgrade` when
 * not already present. Must be idempotent (re-running is a no-op) and must
 * not error when the service is pre-installed.
 *
 * RED anchor: imports `migration007` from "../007-daemon-required.js" which
 * does not yet exist. Wave 4 lands `src/packaging/migrations/007-daemon-required.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MigrationContext } from "../../migrations.js";

// Mock `installService` BEFORE importing the migration under test so that
// (a) tests run without touching real launchd/systemd, and (b) we can assert
// call counts per scenario.
vi.mock("../../../daemon/service-file.js", () => ({
  installService: vi.fn(async (_config: { dataDir: string }) => ({
    success: true,
    platform: "darwin",
    servicePath: "/tmp/fake-plist",
  })),
  uninstallService: vi.fn(async () => undefined),
}));

import { migration007 } from "../007-daemon-required.js"; // INTENTIONALLY MISSING — Wave 4 creates this.
import { installService } from "../../../daemon/service-file.js";

describe("Migration 007: daemon-required (D-14)", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let installServiceMock: ReturnType<typeof vi.mocked<typeof installService>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-mig007-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    installServiceMock = vi.mocked(installService);
    installServiceMock.mockClear();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("D-14: migration has id '007-daemon-required' and a 1.x.0 version", () => {
    expect(migration007.id).toBe("007-daemon-required");
    expect(migration007.version).toMatch(/^1\.\d+\.0$/);
    expect(typeof migration007.description).toBe("string");
    expect(migration007.description.length).toBeGreaterThan(0);
  });

  it("D-14 skip: plist present at ~/Library/LaunchAgents/ai.openclaw.aof.plist → installService NOT called", async () => {
    const plistDir = join(tmpDir, "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    await writeFile(join(plistDir, "ai.openclaw.aof.plist"), "<plist/>");

    const ctx: MigrationContext = {
      aofRoot: join(tmpDir, ".aof", "data"),
      version: "1.15.0",
    };
    await migration007.up(ctx);

    expect(installServiceMock).not.toHaveBeenCalled();
  });

  it("D-14 skip: systemd unit present at ~/.config/systemd/user/ai.openclaw.aof.service → installService NOT called", async () => {
    const unitDir = join(tmpDir, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, "ai.openclaw.aof.service"), "[Service]\n");

    const ctx: MigrationContext = {
      aofRoot: join(tmpDir, ".aof", "data"),
      version: "1.15.0",
    };
    await migration007.up(ctx);

    expect(installServiceMock).not.toHaveBeenCalled();
  });

  it("D-14 install: neither plist nor unit present → installService called once with dataDir = aofRoot", async () => {
    const aofRoot = join(tmpDir, ".aof", "data");
    const ctx: MigrationContext = { aofRoot, version: "1.15.0" };

    await migration007.up(ctx);

    expect(installServiceMock).toHaveBeenCalledTimes(1);
    const [config] = installServiceMock.mock.calls[0]!;
    // The migration passes the ctx.aofRoot as dataDir — the data dir lives
    // alongside the install root per migration 006.
    expect(config.dataDir).toBe(aofRoot);
  });

  it("D-14 idempotent: rerun after successful install → installService NOT called a second time", async () => {
    const aofRoot = join(tmpDir, ".aof", "data");
    const ctx: MigrationContext = { aofRoot, version: "1.15.0" };

    // First run installs.
    await migration007.up(ctx);
    expect(installServiceMock).toHaveBeenCalledTimes(1);

    // Simulate post-install state: plist now exists (as if launchd registered it).
    const plistDir = join(tmpDir, "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    await writeFile(join(plistDir, "ai.openclaw.aof.plist"), "<plist/>");

    // Second run must short-circuit.
    await migration007.up(ctx);
    expect(installServiceMock).toHaveBeenCalledTimes(1);
  });
});
