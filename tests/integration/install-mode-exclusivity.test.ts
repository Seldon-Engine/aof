/**
 * Integration test for scripts/install.sh daemon-install behavior.
 *
 * File name is legacy (Phase 42 "mode-exclusivity"); Phase 43 reversed that
 * policy — the daemon is always installed now, plugin-mode included. The
 * test name kept to avoid rename churn; the describe block reflects the
 * Phase 43 reality.
 *
 * Exercised decisions:
 * - Phase 43 D-01: always install the daemon, regardless of plugin-mode
 * - Phase 43 D-04: --force-daemon is deprecated; flag still accepted but
 *   emits a deprecation warning and otherwise matches default behavior
 * - Phase 42 D-01: plugin-mode detection via ~/.openclaw/extensions/aof
 *   (still used by print_summary for informational output)
 *
 * Prerequisites:
 * - `npm run build` has run (populates dist/)
 * - A tarball at aof-<package.json version>.tar.gz at the repo root
 *   (built by beforeAll via `node scripts/build-tarball.mjs <version>`).
 *   Version is read from package.json to satisfy build-tarball.mjs's
 *   coherence check.
 *
 * Run: npx vitest run --config tests/integration/vitest.config.ts \
 *        tests/integration/install-mode-exclusivity.test.ts
 *
 * NOTE: after Phase 42→43 source changes, the tarball must be rebuilt before
 * running this test — scripts/install.sh is packaged into it. The beforeAll
 * below only builds the tarball if absent; a stale tarball from Phase 42
 * will still exist and must be cleared first:
 *
 *   rm -f aof-*.tar.gz && AOF_INTEGRATION=1 npx vitest run --config \
 *     tests/integration/vitest.config.ts \
 *     tests/integration/install-mode-exclusivity.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

// scripts/build-tarball.mjs enforces version coherence (tarball version MUST
// equal package.json version), so we mint the fixture from the current
// package.json version rather than a hardcoded test string. The tarball is
// still local / test-only because the sandbox $HOME scopes all filesystem
// effects — no real launchd registration occurs.
const PKG_VERSION: string = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
).version;
const TARBALL = join(REPO_ROOT, `aof-${PKG_VERSION}.tar.gz`);

// Skip unless:
//   - running on darwin (launchctl plist semantics assumed by test), AND
//   - explicitly opted-in via AOF_INTEGRATION=1.
const SHOULD_RUN =
  process.platform === "darwin" && process.env.AOF_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("install.sh always-install-daemon (Phase 43 D-01/D-04)", () => {
  let sandbox: string;
  let fakeHome: string;
  let prefix: string;
  let dataDir: string;

  beforeAll(() => {
    // On-demand tarball fixture build. 30s one-time cost per cold run;
    // subsequent runs hit the cached artifact. If source changes since the
    // last build, delete aof-*.tar.gz at the repo root before running.
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

  it("D-01: installs the daemon even when the plugin symlink is present", () => {
    createPluginSymlink();
    const output = runInstall();

    // Phase 43 no longer skips the daemon in plugin-mode. The Phase-42-era
    // "skipping standalone daemon" note is gone; an install attempt must
    // occur.
    expect(output).not.toMatch(/skipping standalone daemon/);
    expect(output).not.toMatch(/Daemon: skipped/);
    expect(output).toMatch(/Installing daemon service/);
    // launchctl bootstrap against a sandboxed $HOME may not actually load
    // into the user domain, so either the success or non-fatal-warn path is
    // acceptable — what matters is that install was attempted, not skipped.
    expect(output).toMatch(/Daemon (installed and running|install failed)/);
  });

  it("regression: pure standalone (no symlink) installs daemon", () => {
    const output = runInstall();
    // Pure-standalone path — no plugin symlink, no deprecation warn, daemon
    // install attempted. Behavior matches D-01 default: daemon is always
    // installed regardless of plugin detection.
    expect(output).not.toMatch(/DEPRECATED/);
    expect(output).toMatch(/Installing daemon service/);
    expect(output).toMatch(/Daemon (installed and running|install failed)/);
  });

  it("D-04: --force-daemon emits deprecation warning and still installs", () => {
    createPluginSymlink();
    const output = runInstall(["--force-daemon"]);
    // Flag is a no-op with a loud deprecation warning. Default behavior
    // (install daemon) happens regardless.
    expect(output).toMatch(/--force-daemon is DEPRECATED/);
    expect(output).toMatch(/Installing daemon service/);
    // Phase-42 dual-polling warning must be gone — there is no "forcing
    // despite plugin-mode" state anymore.
    expect(output).not.toMatch(/Dual-polling will occur/);
  });

  it("D-04: --help tags --force-daemon as DEPRECATED", () => {
    const out = execFileSync("sh", ["scripts/install.sh", "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    // Flag is still listed (backward compat for v1.14 scripts/CI) but clearly
    // marked as a no-op.
    expect(out).toContain("--force-daemon");
    expect(out).toMatch(/--force-daemon\s+\[DEPRECATED\]/);
  });
});
