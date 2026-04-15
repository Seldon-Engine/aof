/**
 * Regression tests for channel.json defensive handling.
 *
 * Pre-v1.14.9, `updateVersionConfig` wrote channel.json with only
 * `version` and `lastUpdated`, omitting the `channel` field. On the
 * next `aof update`, `checkForUpdates` read that config, passed the
 * undefined `channel` to `fetchReleaseManifest`, which silently fell
 * into the list-endpoint branch (`/releases` instead of
 * `/releases/latest`), received an array, and crashed in
 * `parseReleaseData` with:
 *     TypeError: Cannot read properties of undefined (reading 'replace')
 *
 * Fix spans three sites:
 *   1. checkForUpdates normalizes `config.channel` against VALID_CHANNELS.
 *   2. updateVersionConfig seeds `channel: "stable"` when absent before
 *      writing back.
 *   3. fetchReleaseManifest throws a clear error if it receives an
 *      invalid channel (defense in depth; no current caller should hit it).
 *
 * These tests pin each site independently so a future refactor can't
 * silently drop the guard on one layer without flagging it here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkForUpdates } from "../channels.js";

describe("channel.json defensive handling (v1.14.9 regression suite)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `aof-channel-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("checkForUpdates treats a channel-less config as stable and hits /releases/latest", async () => {
    // channel.json written by pre-v1.14.9 updateVersionConfig: no `channel` field.
    await mkdir(join(testDir, ".aof"), { recursive: true });
    await writeFile(
      join(testDir, ".aof", "channel.json"),
      JSON.stringify({ version: "1.14.7", lastUpdated: "2026-04-15T00:00:00Z" }),
    );

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v1.14.9",
        name: "Release 1.14.9",
        body: "Channel normalization fix",
        published_at: "2026-04-15T18:58:14Z",
      }),
    } as Response);
    global.fetch = fetchSpy;

    const result = await checkForUpdates(testDir, { force: true });

    // URL picked must be the single-release endpoint (what `stable` uses),
    // not the list endpoint (the symptom of the bug).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).toMatch(/\/releases\/latest$/);

    expect(result.updateAvailable).toBe(true);
    expect(result.currentVersion).toBe("1.14.7");
    expect(result.latestVersion).toBe("1.14.9");
  });

  it("checkForUpdates treats a garbage-channel config as stable", async () => {
    // A corrupted config with an unknown channel string. Previously the
    // same undefined-URL path; now should snap to stable.
    await mkdir(join(testDir, ".aof"), { recursive: true });
    await writeFile(
      join(testDir, ".aof", "channel.json"),
      JSON.stringify({ channel: "nightly-🚀", version: "1.14.7" }),
    );

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v1.14.9", name: "x", body: "", published_at: "2026-04-15T00:00:00Z",
      }),
    } as Response);
    global.fetch = fetchSpy;

    await checkForUpdates(testDir, { force: true });

    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/releases\/latest$/);
  });

  it("checkForUpdates persists the normalized channel back to disk", async () => {
    await mkdir(join(testDir, ".aof"), { recursive: true });
    await writeFile(
      join(testDir, ".aof", "channel.json"),
      JSON.stringify({ version: "1.14.7" }),
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v1.14.9", name: "x", body: "", published_at: "2026-04-15T00:00:00Z",
      }),
    } as Response);

    await checkForUpdates(testDir, { force: true });

    // After a check, the stored config should now carry `channel: "stable"`
    // so the next run starts from a known-good state without any
    // self-healing logic needing to run again.
    const raw = await readFile(join(testDir, ".aof", "channel.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.channel).toBe("stable");
    expect(config.version).toBe("1.14.7");
  });

  it("fetchReleaseManifest rejects an invalid channel loudly (defense in depth)", async () => {
    // fetchReleaseManifest is not exported. We probe it via the only
    // public entrypoint that currently routes to it with a user-
    // controlled channel value: `getVersionManifest`. Passing a value
    // that isn't one of the Channel literals must reject before the
    // network round-trip.
    const { getVersionManifest } = await import("../channels.js");
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    // Bypass the type-system to simulate a caller that made it past
    // a different validation path (e.g. an older CLI reading a stale
    // channel.json). Cast is intentional: the whole point is to verify
    // the runtime guard fires.
    await expect(
      getVersionManifest("wat" as unknown as "stable", { timeoutMs: 1000 }),
    ).rejects.toThrow(/invalid channel/i);

    // Must fail before making any HTTP request.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
