/**
 * Regression test for `updateVersionConfig` writing the `channel` field
 * into channel.json.
 *
 * Before v1.14.9, `updateVersionConfig` wrote `{ version, lastUpdated }`
 * and nothing else. If the incoming channel.json had a `channel` field
 * the write-back preserved it (JSON spread), but if it didn't — which
 * was the case for every install written by an older
 * `updateVersionConfig` in a chain of successive updates — the new
 * channel.json still wouldn't have one, and the NEXT `aof update` would
 * crash with `Cannot read properties of undefined (reading 'replace')`
 * because `checkForUpdates` passed `undefined` to `fetchReleaseManifest`.
 *
 * Fix: `updateVersionConfig` now seeds `channel: "stable"` when the
 * loaded config doesn't already have one, terminating the cycle on
 * every update.
 *
 * See also: src/packaging/__tests__/channels-missing-field.test.ts for
 * the defensive read-side normalization in `checkForUpdates` that
 * covers already-broken installs out there.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selfUpdate, type UpdateOptions } from "../updater.js";

function createTestTarball(): Buffer {
  const staging = mkdtempSync(join(tmpdir(), "aof-channel-tarball-"));
  writeFileSync(join(staging, "package.json"), '{"name":"aof","version":"0.0.0-test"}');
  const tarPath = join(staging, "test.tar.gz");
  execSync(`tar -czf "${tarPath}" -C "${staging}" package.json`);
  const buf = readFileSync(tarPath);
  execSync(`rm -rf "${staging}"`);
  return buf;
}

function mockTarballResponse(tarballData: Buffer) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(tarballData));
      controller.close();
    },
  });
  return {
    ok: true,
    body: stream,
    arrayBuffer: async () => tarballData.buffer.slice(
      tarballData.byteOffset,
      tarballData.byteOffset + tarballData.byteLength,
    ),
  } as Response;
}

describe("updateVersionConfig — channel field preservation", () => {
  let tmpDir: string;
  let aofRoot: string;
  let mockFetch: ReturnType<typeof vi.fn>;
  let realTarball: Buffer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-updater-channel-"));
    aofRoot = join(tmpDir, "aof");
    realTarball = createTestTarball();
    await mkdir(aofRoot, { recursive: true });
    await mkdir(join(aofRoot, ".aof"), { recursive: true });

    mockFetch = vi.fn().mockResolvedValue(mockTarballResponse(realTarball));
    global.fetch = mockFetch;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function runUpdate(
    targetVersion: string,
    preservePaths: string[] = [".aof"],
  ): Promise<void> {
    // Production defaults include `.aof` (so the user's channel choice
    // survives upgrades). Tests mirror that unless explicitly overriding.
    const opts: UpdateOptions = {
      aofRoot,
      targetVersion,
      downloadUrl: `https://example.com/aof-${targetVersion}.tar.gz`,
      preservePaths,
    };
    await selfUpdate(opts);
  }

  it("adds channel=stable when the pre-existing channel.json omits it", async () => {
    // Simulate an install written by pre-v1.14.9 updateVersionConfig:
    // version + lastUpdated only, no channel. Even with `.aof` in
    // preservePaths (so the file survives the wipe), the final
    // updateVersionConfig pass must write the missing channel.
    await writeFile(
      join(aofRoot, ".aof", "channel.json"),
      JSON.stringify({ version: "1.14.7", lastUpdated: "2026-04-15T00:00:00Z" }),
    );

    await runUpdate("1.14.9");

    const config = JSON.parse(
      await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
    );
    expect(config.channel).toBe("stable");
    expect(config.version).toBe("1.14.9");
    expect(typeof config.lastUpdated).toBe("string");
  });

  it("preserves an existing channel value through update", async () => {
    // If the install was already on beta (or any valid channel), we
    // must not clobber that choice back to stable.
    await writeFile(
      join(aofRoot, ".aof", "channel.json"),
      JSON.stringify({ channel: "beta", version: "1.14.7-rc.1" }),
    );

    await runUpdate("1.14.9-rc.2");

    const config = JSON.parse(
      await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
    );
    expect(config.channel).toBe("beta");
    expect(config.version).toBe("1.14.9-rc.2");
  });

  it("seeds channel=stable on a first-ever write (no pre-existing channel.json)", async () => {
    // Fresh install case: no channel.json file yet. updateVersionConfig
    // starts from an empty object. Must still end up with a channel.
    // Explicitly override preservePaths to [] to simulate the case
    // where nothing gets preserved (e.g. a clean reinstall).
    await runUpdate("1.14.9", []);

    const config = JSON.parse(
      await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
    );
    expect(config.channel).toBe("stable");
    expect(config.version).toBe("1.14.9");
  });
});
