/**
 * Integration test for Phase 42 installer mode-exclusivity.
 *
 * Shells out to scripts/install.sh against a sandboxed $HOME, exercising:
 * - D-01: plugin-mode detection via ~/.openclaw/extensions/aof
 * - D-03: auto-skip when plugin present, no prior daemon
 * - D-04: --force-daemon override (+ --help advertisement)
 * - D-05: convergence — uninstall pre-existing daemon on upgrade
 * - Regression: pure standalone path unchanged
 *
 * Prerequisites:
 * - `npm run build` has run (populates dist/)
 * - A tarball at .release-staging/aof-v<package.json version>.tar.gz
 *   (built by beforeAll via `node scripts/build-tarball.mjs <version>`).
 *   The version is read from package.json to satisfy build-tarball.mjs's
 *   coherence check (tarball version must match package.json version).
 *
 * Run: npx vitest run --config tests/integration/vitest.config.ts \
 *        tests/integration/install-mode-exclusivity.test.ts
 *
 * NOTE (Wave 0 — Phase 42-01): These specs are intentionally RED.
 * install.sh has no plugin-mode gate yet; Plans 02/03/04 turn them green:
 *   - Plan 02 → specs "D-01/D-03" and "regression" (detection + skip branch)
 *   - Plan 03 → specs "D-04: --force-daemon" and "D-04: --help lists --force-daemon"
 *   - Plan 04 → spec "D-05: removes pre-existing daemon"
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

// scripts/build-tarball.mjs enforces version coherence (tarball version MUST
// equal package.json version), so we mint the fixture from the current
// package.json version rather than a hardcoded "0.0.0-test" string. The
// tarball is still "local / test-only" because the sandbox $HOME scopes all
// filesystem effects — no real launchd registration occurs.
const PKG_VERSION: string = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
).version;
const TARBALL = join(
  REPO_ROOT,
  ".release-staging",
  `aof-v${PKG_VERSION}.tar.gz`,
);

// Skip unless:
//   - running on darwin (launchctl plist semantics assumed by test), AND
//   - explicitly opted-in via AOF_INTEGRATION=1 (set by
//     `npm run test:integration:plugin`). The opt-in keeps the `npm test`
//     (unit) suite green — the root vitest.config.ts include glob matches
//     this file, but the describe stays skipped without the flag.
const SHOULD_RUN =
  process.platform === "darwin" && process.env.AOF_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("install.sh mode-exclusivity", () => {
  let sandbox: string;
  let fakeHome: string;
  let prefix: string;
  let dataDir: string;

  beforeAll(() => {
    // On-demand tarball fixture build (Phase 42 decision: mirrors
    // tests/integration/plugin-load.test.ts's Docker preflight pattern).
    // 30s one-time cost per cold run; subsequent runs hit the cached artifact.
    if (!existsSync(TARBALL)) {
      execFileSync("node", ["scripts/build-tarball.mjs", PKG_VERSION], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
    }
  }, 45_000);

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "aof-install-mode-"));
    fakeHome = join(sandbox, "home");
    prefix = join(fakeHome, ".aof");
    dataDir = join(fakeHome, ".aof-data");
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function runInstall(args: string[] = []): string {
    return execFileSync(
      "sh",
      [
        "scripts/install.sh",
        "--tarball",
        TARBALL,
        "--prefix",
        prefix,
        "--data-dir",
        dataDir,
        ...args,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: fakeHome,
          OPENCLAW_HOME: join(fakeHome, ".openclaw"),
        },
        encoding: "utf-8",
      },
    );
  }

  function createPluginSymlink(): void {
    mkdirSync(join(fakeHome, ".openclaw", "extensions"), { recursive: true });
    symlinkSync(
      "/nonexistent/aof/dist",
      join(fakeHome, ".openclaw", "extensions", "aof"),
    );
  }

  function createFakePlist(): string {
    const plist = join(
      fakeHome,
      "Library",
      "LaunchAgents",
      "ai.openclaw.aof.plist",
    );
    mkdirSync(join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, "<?xml version='1.0'?><plist/>", "utf-8");
    return plist;
  }

  it("D-01/D-03: skips daemon install when plugin symlink is present", () => {
    createPluginSymlink();
    const output = runInstall();
    expect(output).toMatch(/Plugin-mode detected.*skipping standalone daemon/);
    expect(output).toMatch(/Daemon: skipped/);
    expect(
      existsSync(
        join(fakeHome, "Library", "LaunchAgents", "ai.openclaw.aof.plist"),
      ),
    ).toBe(false);
  });

  it("D-05: removes pre-existing daemon on upgrade with plugin present", () => {
    createPluginSymlink();
    const plist = createFakePlist();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "daemon.pid"), "99999", "utf-8");
    writeFileSync(join(dataDir, "daemon.sock"), "", "utf-8");

    const output = runInstall();
    expect(output).toMatch(/removing redundant standalone daemon/);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(join(dataDir, "daemon.pid"))).toBe(false);
    expect(existsSync(join(dataDir, "daemon.sock"))).toBe(false);
  });

  it("regression: pure standalone (no symlink) still installs daemon", () => {
    const output = runInstall();
    expect(output).not.toMatch(/Plugin-mode detected/);
    // In the fake-home sandbox, launchctl bootstrap fails against the non-user
    // domain; either "installed and running" or the non-fatal warn is acceptable.
    expect(output).toMatch(/Daemon (installed and running|install failed)/);
  });

  it("D-04: --force-daemon installs even with plugin-mode detected", () => {
    createPluginSymlink();
    const output = runInstall(["--force-daemon"]);
    expect(output).toMatch(/--force-daemon set/);
    expect(output).toMatch(/Installing daemon service/);
  });

  it("D-04: --help lists --force-daemon", () => {
    const out = execFileSync("sh", ["scripts/install.sh", "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(out).toContain("--force-daemon");
  });
});
