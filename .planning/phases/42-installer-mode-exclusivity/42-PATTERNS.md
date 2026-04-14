# Phase 42: Installer mode-exclusivity — Pattern Map

**Mapped:** 2026-04-14
**Files analyzed:** 4 (2 edits + 1 new + 1 test-extension)
**Analogs found:** 4 / 4

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `scripts/install.sh` (modify: `parse_args`, `install_daemon`, `print_summary`; add `plugin_mode_detected`) | shell installer | `install.sh → node dist/cli/index.js daemon (install\|uninstall) → (un)installService()` | itself — extends existing functions | in-place |
| `src/daemon/__tests__/service-file.test.ts` (extend with `uninstallService` describe block) | unit test | mocked `execSync` / `existsSync` / `unlinkSync` | existing `launchctlInstallIdempotent` block (same file, L232–355) | exact (same file, sibling describe) |
| `tests/integration/install-mode-exclusivity.test.ts` (new) | integration test | Vitest → `execFileSync("sh", ["scripts/install.sh", ...])` against sandboxed `$HOME` | `tests/integration/dispatch-pipeline.test.ts` (mkdtemp + beforeEach/afterEach) + `tests/integration/plugin-load.test.ts` (execAsync shell-out harness + docstring preamble) | role-match (no installer-integration precedent; two existing patterns composed) |
| `scripts/build-tarball.mjs` (consumed, not modified) | fixture producer | `beforeAll` → `execFileSync("node", ["scripts/build-tarball.mjs", "0.0.0-test"])` → `.release-staging/aof-v0.0.0-test.tar.gz` | n/a — invoked as-is | pass-through |

**Not modified (confirmed by RESEARCH.md §Architectural Responsibility Map + A4):**
- `src/cli/commands/daemon.ts` — `daemonUninstall` already wraps `uninstallService` correctly; no flag changes needed.
- `src/daemon/service-file.ts` — `uninstallService` already covers macOS + Linux + socket/pid cleanup.
- `src/cli/commands/setup.ts` — `wireOpenClawPluginDirect` is cited (D-02) but not invoked on the Phase 42 code path.
- `src/plugin.ts`, `src/daemon/daemon.ts`, `src/openclaw/adapter.ts` — explicitly fenced off by CLAUDE.md §"Fragile — Tread Carefully".

---

## Pattern Assignments

### `scripts/install.sh` — `plugin_mode_detected` (NEW helper)

**Analog:** `scripts/install.sh::remove_external_integration` (L915–943) — the ONLY other code in this file that tests the symlink at `$OPENCLAW_HOME/extensions/aof`. The new function is the detection dual of that teardown.

**Existing excerpt to mirror** (`scripts/install.sh:918–923`):
```sh
  # Current plugin symlink
  local ext_link="$OPENCLAW_HOME/extensions/aof"
  if [ -L "$ext_link" ] || [ -e "$ext_link" ]; then
    rm -rf "$ext_link" || warn "Could not remove $ext_link"
    say "Removed $ext_link"
  fi
```

**Template for new helper (per RESEARCH.md §Pattern 1):**
```sh
# plugin_mode_detected — returns 0 if OpenClaw plugin integration is present.
# Detection signal (D-01): ~/.openclaw/extensions/aof exists as a symlink
# OR a directory. The symlink is created by scripts/deploy.sh:140; a directory
# indicates a legacy hand-copy install and also counts.
# Zero-dep, no CLI call, no config read, safe to call multiple times.
plugin_mode_detected() {
  ext_link="$OPENCLAW_HOME/extensions/aof"
  if [ -L "$ext_link" ] || [ -d "$ext_link" ]; then
    return 0
  fi
  return 1
}
```

**Placement:** sibling to `service_is_loaded` (install.sh:383), before `install_daemon` at L660. No `local` — POSIX-safe, callable top-level.

**Globals to reuse (no new state):**
- `OPENCLAW_HOME` — already initialized at install.sh:47: `OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"`.

**Choice of test: `-d` vs `-e`.** RESEARCH.md §Code Examples §1 notes that `remove_external_integration` uses `-L || -e` for teardown, but detection prefers `-L || -d` so a stray regular file doesn't trip the gate. Executor picks; recommendation is `-d`.

---

### `scripts/install.sh` — `parse_args` extension (flag + `--help` line)

**Analog (in-file):** existing `--force` arm at L107–109 and `--force` help line at L132–133.

**Concrete excerpts to copy from:**

*Globals block* (`scripts/install.sh:41–47`):
```sh
FRESH_INSTALL=""
CLEAN_INSTALL=""
ASSUME_YES=""
FORCE_CLEAN=""
LOCAL_TARBALL=""
BACKUP_DIR=""
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
```

*Flag-parse case arm* (`scripts/install.sh:101–109`):
```sh
      --clean)
        CLEAN_INSTALL="true"
        ;;
      --yes|-y)
        ASSUME_YES="true"
        ;;
      --force)
        FORCE_CLEAN="true"
        ;;
```

*Help-block `printf` style* (`scripts/install.sh:128–136`):
```sh
        printf "  --clean                 Wipe install directory + OpenClaw integration\n"
        printf "                          points, perform fresh install. User data at\n"
        printf "                          --data-dir is not touched.\n"
        printf "  --yes, -y               Skip confirmation prompts (requires --clean)\n"
        printf "  --force                 Proceed with --clean even if openclaw-gateway\n"
        printf "                          appears to be running.\n"
        printf "  --tarball <path>        Install from a local tarball instead of\n"
        printf "                          downloading from GitHub. Intended for testing\n"
        printf "                          unreleased builds.\n"
```

**Template for `--force-daemon`** (per RESEARCH.md §Pattern 2):
```sh
# --- add to globals near install.sh:44 ---
FORCE_DAEMON=""

# --- add to parse_args case, adjacent to --force (install.sh:107) ---
      --force-daemon)
        FORCE_DAEMON="true"
        ;;

# --- add to --help block, after the --force lines (install.sh:132–133) ---
        printf "  --force-daemon          Install the standalone daemon even when\n"
        printf "                          OpenClaw plugin-mode is detected. Not\n"
        printf "                          recommended — both AOFService instances\n"
        printf "                          will poll the same data dir.\n"
```

---

### `scripts/install.sh` — `install_daemon` gate (MODIFY)

**Current body to replace** (`scripts/install.sh:656–671`):
```sh
# --- Install daemon ---

DAEMON_INSTALLED=""

install_daemon() {
  if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
    say "Installing daemon service..."
    if node "$INSTALL_DIR/dist/cli/index.js" daemon install \
      --data-dir "$DATA_DIR" 2>&1; then
      DAEMON_INSTALLED="true"
      say "Daemon installed and running"
    else
      warn "Daemon install failed (non-fatal) — run 'aof daemon install' manually"
    fi
  fi
}
```

**Analog for the D-05 uninstall shell-out:** the same file's `daemon install` shell-out at L663 — identical shape, just swap the verb.

**Analog for best-effort `|| warn` pattern:** `scripts/install.sh:394` (`launchctl bootout ... 2>/dev/null || true`) and install.sh:668 (`warn "Daemon install failed (non-fatal)..."`). The D-05 step MUST suffix `|| warn ...` because `set -eu` at install.sh:11 would otherwise abort the install on uninstall failure (RESEARCH.md §Pitfall 2).

**Template (per RESEARCH.md §Pattern 3):**
```sh
install_daemon() {
  # Mode-exclusivity gate (Phase 42).
  if plugin_mode_detected && [ -z "$FORCE_DAEMON" ]; then
    plist="$HOME/Library/LaunchAgents/ai.openclaw.aof.plist"
    if [ -f "$plist" ]; then
      # D-05: pre-existing dual-mode install — converge to plugin-only.
      say "Plugin-mode detected; removing redundant standalone daemon."
      if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
        node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall \
          --data-dir "$DATA_DIR" 2>&1 || \
          warn "Daemon uninstall returned non-zero (continuing — plist may already be gone)"
      fi
    else
      say "Plugin-mode detected — skipping standalone daemon. Scheduler runs in-process via openclaw gateway."
    fi
    # DAEMON_INSTALLED stays empty; print_summary branches on that.
    return 0
  fi

  if plugin_mode_detected && [ -n "$FORCE_DAEMON" ]; then
    warn "--force-daemon set: installing daemon despite plugin-mode detection. Dual-polling will occur."
  fi

  # Existing install path — unchanged from today.
  if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
    say "Installing daemon service..."
    if node "$INSTALL_DIR/dist/cli/index.js" daemon install \
      --data-dir "$DATA_DIR" 2>&1; then
      DAEMON_INSTALLED="true"
      say "Daemon installed and running"
    else
      warn "Daemon install failed (non-fatal) — run 'aof daemon install' manually"
    fi
  fi
}
```

**Verified downstream entry point** (`src/cli/commands/daemon.ts:312–320`):
```ts
async function daemonUninstall(dataDir: string): Promise<void> {
  try {
    await uninstallService(dataDir);
    console.log("Daemon uninstalled. Service file removed.");
  } catch (err) {
    console.error(`Failed to uninstall daemon: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
```

And its implementation (`src/daemon/service-file.ts:375–409`) handles macOS `launchctl bootout`, Linux `systemctl --user disable --now`, plist/unit-file removal, plus `daemon.sock` + `daemon.pid` unlink. No additional cleanup required.

---

### `scripts/install.sh` — `print_summary` three-way branch (MODIFY)

**Current two-state branch** (`scripts/install.sh:726–730`):
```sh
  if [ -n "$DAEMON_INSTALLED" ]; then
    printf "  Daemon: installed and running\n"
  else
    printf "  Daemon: not installed — run 'aof daemon install' to start\n"
  fi
```

**Current Next-Steps branch** (`scripts/install.sh:740–745`):
```sh
  if [ -z "$DAEMON_INSTALLED" ]; then
    printf "    3. Start the daemon:      aof daemon install\n"
    printf "    4. Create your first task: aof task create \"My first task\"\n"
  else
    printf "    3. Create your first task: aof task create \"My first task\"\n"
  fi
```

**Template for three-way branch (per RESEARCH.md §Pattern 4):**
```sh
# Replace install.sh:726-730 with:
  if plugin_mode_detected && [ -z "$DAEMON_INSTALLED" ]; then
    printf "  Daemon: skipped (scheduler runs via OpenClaw plugin)\n"
  elif [ -n "$DAEMON_INSTALLED" ]; then
    printf "  Daemon: installed and running\n"
  else
    printf "  Daemon: not installed — run 'aof daemon install' to start\n"
  fi

# Replace install.sh:740-745 with:
  if plugin_mode_detected && [ -z "$DAEMON_INSTALLED" ]; then
    # Plugin mode — scheduler is in-process, nothing to start.
    printf "    3. Create your first task: aof task create \"My first task\"\n"
  elif [ -z "$DAEMON_INSTALLED" ]; then
    printf "    3. Start the daemon:      aof daemon install\n"
    printf "    4. Create your first task: aof task create \"My first task\"\n"
  else
    printf "    3. Create your first task: aof task create \"My first task\"\n"
  fi
```

---

### `src/daemon/__tests__/service-file.test.ts` — `uninstallService` describe block (EXTEND)

**Analog:** same-file `describe("launchctlInstallIdempotent", ...)` block at L229–355. New block goes after it.

**Imports already present** (`src/daemon/__tests__/service-file.test.ts:1–12`):
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  getServiceFilePath,
  launchctlInstallIdempotent,
  AOF_SERVICE_LABEL,
  type LaunchctlOps,
  type ServiceFileConfig,
} from "../service-file.js";
```
**Add to import list:** `uninstallService`.

**Ops-mock pattern to copy** (`src/daemon/__tests__/service-file.test.ts:237–257`):
```ts
  function makeOps(loadedSequence: boolean[]): {
    ops: LaunchctlOps;
    calls: string[];
  } {
    const calls: string[] = [];
    let i = 0;
    const ops: LaunchctlOps = {
      isLoaded: () => {
        const v = loadedSequence[Math.min(i++, loadedSequence.length - 1)] ?? false;
        calls.push(`isLoaded=${v}`);
        return v;
      },
      exec: (cmd) => {
        calls.push(cmd);
      },
      sleep: async () => {
        calls.push("sleep");
      },
    };
    return { ops, calls };
  }
```

**Error-swallowing assertion pattern** (`src/daemon/__tests__/service-file.test.ts:328–354`) — this is the direct analog for the "uninstall twice is safe" test (D-05 idempotency):
```ts
  it("swallows errors from the best-effort bootout", async () => {
    const calls: string[] = [];
    const ops: LaunchctlOps = {
      isLoaded: () => {
        calls.push("isLoaded=false");
        return false;
      },
      exec: (cmd) => {
        if (cmd.includes("bootout")) {
          throw new Error("not loaded");
        }
        calls.push(cmd);
      },
      sleep: async () => {},
    };

    await expect(
      launchctlInstallIdempotent("/tmp/aof.plist", { label: "ai.openclaw.aof", uid: 501, ops }),
    ).resolves.toBeUndefined();
    // ...
  });
```

**Constraint for new block:** `uninstallService` in `src/daemon/service-file.ts:375–409` calls `execSync` directly (not via injectable ops) and uses `existsSync` / `unlinkSync` from `node:fs`. The test must either:
- (a) use `vi.mock("node:child_process")` + `vi.mock("node:fs")` to stub `execSync`, `existsSync`, `unlinkSync` — Vitest-standard mocking, no new infrastructure; OR
- (b) refactor `uninstallService` to accept an optional `ops` parameter mirroring `launchctlInstallIdempotent` — scope-creep, not required by this phase.

**Recommendation:** path (a). New describe block template:
```ts
describe("uninstallService idempotency", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("second call is a no-op when plist already removed", async () => {
    // Mock execSync to observe launchctl invocations; mock fs so the plist
    // "exists" on the first call, absent on the second.
    // Assert: no throw, execSync("launchctl bootout ...") called both times
    // (best-effort), unlinkSync called only on the first call.
  });

  it("tolerates launchctl bootout throwing (already unloaded)", async () => {
    // Mock execSync to throw; assert uninstallService resolves without error.
  });

  it("swallows unlinkSync errors on daemon.sock / daemon.pid", async () => {
    // Verifies the try/catch blocks at service-file.ts:402-407.
  });
});
```

Reference `uninstallService` source (`src/daemon/service-file.ts:375–409`) — the test maps 1:1 to each try/catch in that function.

---

### `tests/integration/install-mode-exclusivity.test.ts` (NEW)

**Analogs (composed):**
- Docstring preamble style + top-level `describe.skip` conditional: `tests/integration/plugin-load.test.ts:1–77`
- Sandbox / temp-dir `beforeEach` + `afterEach` cleanup: `tests/integration/dispatch-pipeline.test.ts:35–60`
- Shell-out via child_process: `tests/integration/plugin-load.test.ts:22–25, 65` (uses `execAsync`; our test uses the synchronous `execFileSync` variant as recommended in RESEARCH.md §Code Examples §3)

**Config file already exists** (`tests/integration/vitest.config.ts:1–17`) — no new config needed; new file will be auto-picked up:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 45_000,
    globals: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
```

**Docstring preamble pattern** (`tests/integration/plugin-load.test.ts:1–16`):
```ts
/**
 * Integration tests for AOF OpenClaw plugin.
 *
 * These tests run against a REAL containerized OpenClaw instance.
 * They validate that the plugin: ...
 *
 * Prerequisites:
 * - Docker + Docker Compose installed
 * - AOF built (`npm run build` from repo root)
 *
 * Run: npm run test:integration:plugin
 */
```

**Sandbox lifecycle pattern** (`tests/integration/dispatch-pipeline.test.ts:35–60`):
```ts
describe("Dispatch pipeline integration", () => {
  let tmpDir: string;
  // ...

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-dispatch-integration-"));
    // ... setup
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
```

**Platform-guarded describe pattern** (for macOS-only plist scenarios — cited in RESEARCH.md §Wave 0 Gaps). Follow the `describe.skip` pattern at `tests/integration/plugin-load.test.ts:60`:
```ts
// SKIP: This test suite requires Docker + Mule (containerized OpenClaw gateway).
describe.skip("AOF Plugin Integration (Real OpenClaw)", () => { ... });
```
— replace with a conditional for install-mode-exclusivity:
```ts
describe.skipIf(process.platform !== "darwin")("install.sh mode-exclusivity (macOS)", () => { ... });
```

**Template (per RESEARCH.md §Code Examples §3, adjusted to mirror dispatch-pipeline's sync style):**
```ts
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
 * - A tarball at .release-staging/aof-v0.0.0-test.tar.gz
 *   (built by beforeAll via `node scripts/build-tarball.mjs 0.0.0-test`)
 *
 * Run: npx vitest run --config tests/integration/vitest.config.ts \
 *        tests/integration/install-mode-exclusivity.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const TARBALL = join(REPO_ROOT, ".release-staging", "aof-v0.0.0-test.tar.gz");

describe.skipIf(process.platform !== "darwin")("install.sh mode-exclusivity", () => {
  let sandbox: string;
  let fakeHome: string;
  let prefix: string;
  let dataDir: string;

  beforeAll(() => {
    if (!existsSync(TARBALL)) {
      execFileSync("node", ["scripts/build-tarball.mjs", "0.0.0-test"], {
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
      ["scripts/install.sh", "--tarball", TARBALL, "--prefix", prefix, "--data-dir", dataDir, ...args],
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
    symlinkSync("/nonexistent/aof/dist", join(fakeHome, ".openclaw", "extensions", "aof"));
  }

  function createFakePlist(): string {
    const plist = join(fakeHome, "Library", "LaunchAgents", "ai.openclaw.aof.plist");
    mkdirSync(join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, "<?xml version='1.0'?><plist/>", "utf-8");
    return plist;
  }

  it("D-01/D-03: skips daemon install when plugin symlink is present", () => {
    createPluginSymlink();
    const output = runInstall();
    expect(output).toMatch(/Plugin-mode detected.*skipping standalone daemon/);
    expect(output).toMatch(/Daemon: skipped/);
    expect(existsSync(join(fakeHome, "Library", "LaunchAgents", "ai.openclaw.aof.plist"))).toBe(false);
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
```

---

## Shared Patterns

### POSIX shell-test idiom (applies to all new `install.sh` code)
**Source:** `scripts/install.sh:920` (remove_external_integration) and install.sh:679, 684, 690 (validate_install)
**Apply to:** `plugin_mode_detected`, all new conditionals in `install_daemon`, all new `print_summary` branches
**Invariant:** POSIX `[ ... ]` only; NO `[[ ... ]]` bashism (RESEARCH.md §Pitfall 5). Always double-quote `$VAR` expansions.
```sh
if [ -L "$ext_link" ] || [ -d "$ext_link" ]; then
  ...
fi
```

### `say` / `warn` / `err` output style
**Source:** `scripts/install.sh:15–25`
**Apply to:** every new user-facing message in install.sh
```sh
say()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$1" >&2; }
```
**Usage convention:** `say` for success/progress, `warn` for non-fatal surprises (incl. `--force-daemon` override, D-05 uninstall failure), `err` only when followed by `exit 1`. Phase 42 uses `say` + `warn` only.

### Shell-out to `node dist/cli/index.js` from installer
**Source:** `scripts/install.sh:661–666` (existing daemon install)
**Apply to:** D-05 `daemon uninstall` invocation in `install_daemon`
**Invariant:** Always quote `"$INSTALL_DIR"` and `"$DATA_DIR"`. Suffix with `|| warn "..."` when the failure must not abort install under `set -eu` (install.sh:11).
```sh
if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
  node "$INSTALL_DIR/dist/cli/index.js" daemon install \
    --data-dir "$DATA_DIR" 2>&1
fi
```

### Vitest sandbox lifecycle (integration tests)
**Source:** `tests/integration/dispatch-pipeline.test.ts:42–60`
**Apply to:** `tests/integration/install-mode-exclusivity.test.ts`
```ts
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aof-<component>-"));
  // ... setup
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
```
**Divergence:** new test uses sync `mkdtempSync` / `rmSync` (simpler given all install.sh shell-outs are sync via `execFileSync`).

### Ops-injection mocking for service-file tests
**Source:** `src/daemon/__tests__/service-file.test.ts:237–257` (`makeOps` factory) + `:328–354` (error-swallowing assertion)
**Apply to:** the new `describe("uninstallService idempotency", ...)` block — but via `vi.mock("node:child_process")` + `vi.mock("node:fs")` instead of injected ops, because `uninstallService` doesn't accept ops today. No refactor of `uninstallService` in scope.

---

## No Analog Found

All four affected files have analogs. No green-field patterns required.

The ONE design choice left to the planner / executor: in `service-file.test.ts`, either mock `node:child_process` + `node:fs` (preferred — no production code change) or propose a tiny refactor of `uninstallService` to accept optional `ops`. RESEARCH.md §Wave 0 Gaps treats this as an extension, not a refactor — mock approach wins.

---

## Metadata

**Analog search scope:**
- `scripts/install.sh` (full read of critical regions: L1–170, L355–414, L630–747, L900–996)
- `src/daemon/service-file.ts` (L280–326, L370–409)
- `src/daemon/__tests__/service-file.test.ts` (full, 355 lines)
- `src/cli/commands/daemon.ts` (L300–320)
- `src/cli/commands/setup.ts` (L155–195) — for D-02 reference only
- `tests/integration/` (all files listed; read `plugin-load.test.ts`, `dispatch-pipeline.test.ts`, `sdlc-workflow.test.ts`, `vitest.config.ts`)

**Files scanned:** 9
**Pattern extraction date:** 2026-04-14

**Key pattern insight:** This phase is composition, not construction. Every idiom (POSIX shell test, `say`/`warn`, shell-out to `node dist/cli/index.js`, Vitest sandbox lifecycle, ops-mocked service-file test) already exists in the tree. The executor's job is to assemble these five primitives — not invent new ones.
