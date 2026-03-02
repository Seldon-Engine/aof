# Phase 6: Installer - Research

**Researched:** 2026-02-26
**Domain:** Shell installer script, GitHub Release download, OpenClaw plugin wiring, upgrade/migration pipeline
**Confidence:** HIGH

## Summary

Phase 6 creates a `curl | sh` installer script that downloads AOF release tarballs from GitHub, extracts them to `~/.aof`, scaffolds workspace directories, and wires AOF as an OpenClaw plugin. The existing codebase already has substantial TypeScript infrastructure in `src/packaging/` (installer, updater, wizard, migrations, integration, openclaw-cli, channels, ejector) with corresponding tests. However, the outer `install.sh` shell script does not exist yet, and several critical pieces are stubs or have placeholder values.

Key gaps to close: (1) `extractTarball()` in `updater.ts` is a stub that only creates the target directory; (2) `GITHUB_REPO` in `channels.ts` is set to the placeholder `"aof/aof"` instead of the real `"demerzel-ops/aof"`; (3) the `install.sh` shell entry point that users `curl | sh` does not exist; (4) the integration.ts file uses a direct-JSON-edit approach for OpenClaw config, while `openclaw-cli.ts` provides the correct CLI-based approach -- these need reconciliation; (5) the wizard scaffolds to an arbitrary `installDir` but the CONTEXT decisions specify `~/.aof` as the canonical home.

**Primary recommendation:** Build `install.sh` as a POSIX-compatible shell script that performs prerequisite checks and delegates to a Node.js-based installer entrypoint (leveraging the existing `src/packaging/` infrastructure). Fix the three known stubs/placeholders, then wire everything together.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Fully automatic -- zero interactive prompts, pipe-friendly
- Default install location: `~/.aof`
- CLI arg to override install location (e.g. `install.sh --prefix /custom/path`)
- Full workspace scaffolding on fresh install: AOF code, config, plus empty directories for tasks, events, memory, and an org chart template
- Terminal output: show each step with progress indicators (checking Node... done, downloading... done), then a summary with "what to do next" instructions
- Detection strategy: smart detection that handles both legacy installs (users who followed the current deployment guide) and future installs (directory + version file check)
- Must provide clean upgrade path for existing AOF users who installed manually
- Migration pipeline: versioned migrations that can modify tasks/events/memory/config structure when needed
- Auto-backup before any upgrade -- backup data before running migrations
- Auto-run migrations without prompts (consistent with fully-automatic philosophy)
- Auto-rollback from backup if any migration fails -- user returns to pre-upgrade state
- Long-term: version file (`~/.aof/.version` or similar) as the canonical version indicator
- Check: Node >= 22, OpenClaw presence, git, curl/wget, disk space, write permissions on install dir
- On missing prerequisite: print exactly what's missing, how to install it, and exit cleanly -- never modify the system
- OpenClaw is a **soft requirement**: install AOF even without OpenClaw, skip plugin wiring, warn that it won't work until a platform connector is installed
- On partial failure (e.g. download succeeds but scaffolding fails): clean up everything -- remove anything the installer created, leave the machine as if it never ran
- OpenClaw discovery: expose CLI arg for explicit path (validated), otherwise run comprehensive heuristic (known paths including historical ones, env vars like OPENCLAW_HOME)
- If AOF entry already exists: update it
- If AOF entry doesn't exist: add it and **disable any other active memory plugin** (only one memory plugin can be active at a time)
- Config modification: use `openclaw config set/get` CLI commands where possible (avoid direct file editing)
- Post-wiring: run a health check to verify AOF plugin loaded and responds
- If health check fails: roll back the plugin wiring (undo config change), keep AOF files installed -- user can re-run or manually wire later
- Design for platform decoupling: `~/.aof` as independent home dir (not nested under `~/.openclaw`)
- Memory plugin exclusivity: when first installing AOF as a memory plugin, must disable other memory plugins

### Claude's Discretion
- Exact health check implementation
- Heuristic fallback behavior when OpenClaw config not found (prompt vs abort)
- Migration file format and naming convention
- Backup location and naming scheme
- How to detect legacy (pre-installer) AOF installations
- Exact prerequisite check ordering and messages

### Deferred Ideas (OUT OF SCOPE)
- Enhanced memory data import from other memory plugins (current mechanism is proof of concept)
- Support for additional platform connectors beyond OpenClaw
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INST-01 | `curl \| sh` installer detects OS, architecture, Node >= 22, existing OpenClaw | Shell script prerequisite checks; `detectOpenClaw()` in wizard.ts and openclaw-cli.ts; Node version check via `node --version` |
| INST-02 | Installer downloads release tarball from GitHub and extracts correctly (`extractTarball()` fixed) | `updater.ts` download pipeline + stub `extractTarball()` needs implementation using `tar -xzf`; `build-tarball.mjs` creates the tarball in CI |
| INST-03 | Installer runs wizard (directory scaffolding, org chart template, health check) | `wizard.ts` has `runWizard()` with full scaffolding; needs adaptation for `~/.aof` default and fully-automatic mode |
| INST-04 | Installer auto-detects OpenClaw gateway and wires AOF as plugin | `openclaw-cli.ts` has `registerAofPlugin()`, `configureAofAsMemoryPlugin()`, `detectMemoryPlugin()` -- use these, not `integration.ts` direct-edit approach |
| INST-05 | Running installer on existing install upgrades without losing tasks/events/memory data | `updater.ts` `selfUpdate()` with preserve paths; `migrations.ts` framework; backup/rollback pipeline |
| INST-06 | Channels.ts repo URL points to real GitHub repository | `GITHUB_REPO` constant in `channels.ts` is `"aof/aof"` -- must change to `"demerzel-ops/aof"` |
</phase_requirements>

## Standard Stack

### Core
| Component | Location | Purpose | Status |
|-----------|----------|---------|--------|
| `install.sh` | New file (repo root or `scripts/`) | POSIX shell entry point for `curl \| sh` | Does not exist -- must create |
| `src/packaging/updater.ts` | Existing | Download + extract + swap + rollback | `extractTarball()` is a stub |
| `src/packaging/wizard.ts` | Existing | Directory scaffolding + org chart generation | Works, needs ~/.aof default |
| `src/packaging/openclaw-cli.ts` | Existing | OpenClaw config via CLI commands | Works, is the correct approach |
| `src/packaging/migrations.ts` | Existing | Version migration framework | Works, no migrations registered yet |
| `src/packaging/channels.ts` | Existing | Release channel + version manifest | `GITHUB_REPO` placeholder |
| `scripts/build-tarball.mjs` | Existing | CI tarball builder | Works (Phase 5 shipped) |

### Supporting
| Component | Location | Purpose | When to Use |
|-----------|----------|---------|-------------|
| `src/packaging/integration.ts` | Existing | Direct JSON config editing for OpenClaw | **AVOID** -- superseded by `openclaw-cli.ts` |
| `src/packaging/ejector.ts` | Existing | Removes AOF from OpenClaw | Not needed for install, but relevant for rollback |
| `src/packaging/installer.ts` | Existing | npm dependency installer (wraps npm ci/install) | Post-extract dependency installation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Shell `tar -xzf` for extraction | npm `tar` package | Shell `tar` is universally available on macOS/Linux, zero dependencies, simpler for the shell script context |
| `openclaw config set/get` CLI | Direct JSON editing (integration.ts) | CLI is safer (validates config, handles backup), user decision locks this |
| Single shell-only installer | Shell + Node.js hybrid | Node.js already required (>= 22), existing TypeScript infrastructure is extensive -- leverage it |

## Architecture Patterns

### Recommended install.sh Structure

The `install.sh` script should follow the "function-wrapped" pattern used by nvm, rustup, and similar tools to prevent partial execution if the download is interrupted:

```
install.sh (POSIX shell)
  |
  +-- main()
  |     |-- parse_args (--prefix, --openclaw-path, --version, --channel)
  |     |-- check_prerequisites (node >= 22, git, curl/wget, tar, disk space, write perms)
  |     |-- detect_existing_install (~/.aof/.version, legacy detection)
  |     |-- if upgrade: backup_data()
  |     |-- download_tarball (GitHub Releases API -> tarball URL -> download)
  |     |-- extract_tarball (tar -xzf to temp dir, then move to install dir)
  |     |-- npm ci (install Node.js dependencies)
  |     |-- if fresh: scaffold_workspace (call Node.js wizard)
  |     |-- if upgrade: run_migrations (call Node.js migration runner)
  |     |-- write_version_file (~/.aof/.version)
  |     |-- if openclaw detected: wire_plugin (call Node.js openclaw-cli wiring)
  |     |-- health_check
  |     |-- print_summary
  |
  +-- cleanup_on_failure()  (trap handler)
```

### Pattern 1: Function-Wrapped Shell Script (Partial Download Protection)
**What:** Wrap entire script body in a function, call it at the end
**When to use:** Always, for `curl | sh` safety
**Example:**
```sh
#!/bin/sh
set -eu

main() {
  # ... all logic here ...
}

# Ensure full script downloaded before execution
main "$@"
```

### Pattern 2: Shell-to-Node Delegation
**What:** Shell script handles prerequisites + download + extraction; delegates complex logic (wizard, migrations, plugin wiring) to Node.js
**When to use:** When existing TypeScript infrastructure handles the complex parts
**Why:** The packaging/*.ts modules already implement wizard, migrations, plugin wiring with proper error handling, backup/rollback, and tests. Re-implementing in shell would be error-prone and untestable.
**Example:**
```sh
# After extracting AOF and running npm ci:
node "$INSTALL_DIR/dist/cli/index.js" setup --auto --data-dir "$INSTALL_DIR" 2>&1
```

### Pattern 3: Trap-Based Cleanup
**What:** Register a `trap` handler that cleans up on failure
**When to use:** User decision: partial failure must leave machine clean
**Example:**
```sh
CLEANUP_PATHS=""
cleanup() {
  if [ -n "$CLEANUP_PATHS" ]; then
    for p in $CLEANUP_PATHS; do
      rm -rf "$p" 2>/dev/null || true
    done
  fi
}
trap cleanup EXIT

# When creating new paths, register them:
mkdir -p "$INSTALL_DIR"
CLEANUP_PATHS="$CLEANUP_PATHS $INSTALL_DIR"
```

### Pattern 4: Legacy Install Detection
**What:** Detect pre-installer AOF installations that lack a `.version` file
**When to use:** First upgrade of manually-installed AOF
**Signals for legacy detection:**
- `~/.openclaw/aof/` exists with `tasks/`, `events/`, `memory/` subdirectories but no `.version` file
- `~/.openclaw/extensions/aof/` exists (the old extensions path from deploy-plugin.sh)
- `plugins.load.paths` in openclaw.json points to a directory containing `openclaw.plugin.json`
- Any of these without `~/.aof/.version`
**What to do:** Treat as upgrade, create `.version` file with `0.0.0` (pre-installer), run migrations from `0.0.0`

### Pattern 5: Two-Phase Version File
**What:** Write `.version` file only after successful installation
**When to use:** Always -- version file is the canonical "installation complete" marker
**Format:** Simple text file containing the version string (e.g., `0.1.0`)
**Why not JSON?** Simplicity. Shell can read it with `cat`. No parsing needed.

### Anti-Patterns to Avoid
- **Direct openclaw.json editing:** The `integration.ts` module edits the JSON file directly. The `openclaw-cli.ts` module uses `openclaw config set/get` CLI commands. User decision locks the CLI approach. Direct editing risks race conditions with gateway and config validation issues.
- **Interactive prompts in install.sh:** User decision: fully automatic, zero prompts. If OpenClaw not found: install AOF anyway, skip wiring, print warning.
- **Nested data directory:** Do NOT put AOF data under `~/.openclaw/aof/` for new installs. Use `~/.aof/` as the independent home directory (platform decoupling decision). BUT: must handle legacy data that IS at `~/.openclaw/aof/`.
- **Deleting user data on fresh install --force:** The `--force` flag should overwrite code, never delete tasks/events/memory/config.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tarball extraction | Custom Node.js stream decompress | `tar -xzf` via shell or `execSync` | `tar` is pre-installed on macOS/Linux, battle-tested, handles edge cases (symlinks, permissions) |
| OpenClaw config modification | Direct JSON read/write/save | `openclaw config set/get` CLI (via `openclaw-cli.ts`) | CLI validates config, handles backup, respects config schema, avoids race conditions |
| Semantic version comparison | Custom string parser | Existing `compareVersions()` in `migrations.ts` | Already implemented and tested |
| GitHub Release API | Custom HTTP client | Existing `fetchReleaseManifest()` in `channels.ts` | Already implemented with timeout, channel support |
| Migration tracking | Custom file-based tracking | Existing `migrations.ts` framework | Already has history tracking, up/down support, version ordering |
| Org chart scaffolding | Manual YAML generation | Existing `wizard.ts` `generateOrgChart()` | Already generates valid org charts with schema validation |

**Key insight:** The `src/packaging/` directory already contains ~80% of the needed TypeScript logic. The installer phase is primarily about: (a) creating the shell entry point, (b) fixing stubs/placeholders, (c) adding a Node.js CLI entrypoint that orchestrates the existing modules, and (d) ensuring the upgrade path works for legacy installs.

## Common Pitfalls

### Pitfall 1: Partial Download Execution
**What goes wrong:** If `curl | sh` connection drops mid-download, partial shell script executes with truncated logic, potentially corrupting the system.
**Why it happens:** Shell executes line-by-line as data arrives from the pipe.
**How to avoid:** Wrap all logic in a `main()` function called at the end of the script. The function call only happens after the entire file is downloaded.
**Warning signs:** Any top-level commands outside the main function.

### Pitfall 2: Data Loss on Upgrade
**What goes wrong:** Upgrade replaces the entire `~/.aof` directory, losing tasks, events, and memory data.
**Why it happens:** Not separating "code" from "data" during the swap.
**How to avoid:** The `selfUpdate()` in `updater.ts` already has `preservePaths` support. Ensure the preserve list includes: `tasks/`, `events/`, `memory/`, `state/`, `memory.db`, `memory-hnsw.dat`, `.aof/` (config), and any user-created files. Better approach: only replace code directories (`dist/`, `node_modules/`, `prompts/`, `skills/`), never touch data directories.
**Warning signs:** Any `rm -rf` on the install directory without explicit preservation.

### Pitfall 3: extractTarball() Stub
**What goes wrong:** The updater downloads the tarball successfully but extracts nothing because `extractTarball()` is a no-op stub.
**Why it happens:** Phase 5 noted this as a known gap (`extractTarball() in updater.ts is a stub`).
**How to avoid:** Implement using `execSync("tar -xzf ...")` or Node.js `child_process`. The tarball is created by `build-tarball.mjs` with `tar -czf` using `-C staging .` (contents at root, no wrapper directory).
**Warning signs:** Empty extraction directory after update.

### Pitfall 4: Plugin Wiring Race Condition
**What goes wrong:** Installer modifies openclaw.json while the gateway is running, causing config corruption or the gateway ignoring changes.
**Why it happens:** Direct file editing races with gateway's config file access.
**How to avoid:** Use `openclaw config set/get` CLI commands (already available in `openclaw-cli.ts`). The CLI handles locking and validation.
**Warning signs:** Using `integration.ts` instead of `openclaw-cli.ts`.

### Pitfall 5: GITHUB_REPO Placeholder
**What goes wrong:** Channel checks, update checks, and tarball downloads all fail with 404 because they hit `api.github.com/repos/aof/aof/...` instead of the real repo.
**Why it happens:** `channels.ts` has `const GITHUB_REPO = "aof/aof"; // Replace with actual repo`.
**How to avoid:** Change to `"demerzel-ops/aof"` (matching `package.json` repository URL).
**Warning signs:** 404 errors from GitHub API.

### Pitfall 6: Legacy Data at ~/.openclaw/aof/
**What goes wrong:** New installs go to `~/.aof/` but existing data is at `~/.openclaw/aof/`. Users lose access to their tasks/memory.
**Why it happens:** The current deployment stores AOF data at `~/.openclaw/aof/` (the `DEFAULT_DATA_DIR` in `plugin.ts`).
**How to avoid:** During upgrade detection, check BOTH `~/.aof/` and `~/.openclaw/aof/`. If legacy data exists at `~/.openclaw/aof/`, offer to migrate it to `~/.aof/` (or symlink). Update the plugin config `dataDir` to point to the new location.
**Warning signs:** AOF starts with empty data after "upgrade".

### Pitfall 7: npm ci Requires package-lock.json
**What goes wrong:** `npm ci` fails because the tarball doesn't include `package-lock.json`.
**Why it happens:** `build-tarball.mjs` copies files from the `"files"` field in package.json, which does NOT include `package-lock.json`.
**How to avoid:** Either add `package-lock.json` to the tarball (preferred for reproducible builds) or fall back to `npm install` when lockfile is absent.
**Warning signs:** `npm ERR! This command requires an existing lockfile.`

### Pitfall 8: node_modules Native Modules Cross-Platform
**What goes wrong:** `better-sqlite3` and `hnswlib-node` are native modules that must be compiled for the target platform. Pre-built node_modules from CI won't work.
**Why it happens:** The tarball doesn't (and shouldn't) include `node_modules/`.
**How to avoid:** Run `npm ci` or `npm install` on the target machine after extraction. This compiles native modules locally. Requires build tools (python3, make, g++/clang).
**Warning signs:** `Error: Cannot find module` or `NAPI` errors at runtime.

## Code Examples

### Shell: Prerequisite Check Pattern
```sh
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    err "Node.js is not installed."
    err "Install Node.js >= 22: https://nodejs.org/"
    return 1
  fi

  node_version=$(node --version | sed 's/^v//')
  node_major=$(echo "$node_version" | cut -d. -f1)

  if [ "$node_major" -lt 22 ]; then
    err "Node.js >= 22 required (found v${node_version})"
    err "Upgrade: https://nodejs.org/"
    return 1
  fi

  say "Node.js v${node_version} ... ok"
}

check_openclaw() {
  if ! command -v openclaw >/dev/null 2>&1; then
    warn "OpenClaw not found. AOF will install without plugin wiring."
    warn "Install OpenClaw to use AOF as a platform plugin."
    OPENCLAW_AVAILABLE=false
    return 0  # Soft requirement
  fi

  openclaw_version=$(openclaw --version 2>/dev/null || echo "unknown")
  say "OpenClaw v${openclaw_version} ... ok"
  OPENCLAW_AVAILABLE=true
}
```

### Shell: GitHub Release Download Pattern
```sh
download_tarball() {
  version="$1"
  target_path="$2"
  repo="demerzel-ops/aof"

  if [ "$version" = "latest" ]; then
    url="https://github.com/${repo}/releases/latest/download/aof-latest.tar.gz"
    # Or: query API for latest tag, then construct URL
    tag=$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" | \
          grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
    url="https://github.com/${repo}/releases/download/${tag}/aof-${tag}.tar.gz"
  else
    url="https://github.com/${repo}/releases/download/v${version}/aof-v${version}.tar.gz"
  fi

  say "Downloading AOF ${version}..."

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$target_path" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$target_path" "$url"
  else
    err "Neither curl nor wget found"
    return 1
  fi
}
```

### Shell: Extract Pattern
```sh
extract_tarball() {
  tarball_path="$1"
  target_dir="$2"

  mkdir -p "$target_dir"
  tar -xzf "$tarball_path" -C "$target_dir"
}
```

### TypeScript: Fixed extractTarball() for updater.ts
```typescript
import { execSync } from "node:child_process";

async function extractTarball(tarballPath: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });

  try {
    execSync(`tar -xzf "${tarballPath}" -C "${targetDir}"`, {
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (error) {
    throw new Error(
      `Failed to extract tarball: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
```

### TypeScript: Plugin Wiring via openclaw-cli.ts (existing code, reference)
```typescript
// From src/packaging/openclaw-cli.ts -- already implemented:
import {
  registerAofPlugin,
  configureAofAsMemoryPlugin,
  detectMemoryPlugin,
  isAofPluginRegistered,
} from "./openclaw-cli.js";

// Full wiring sequence:
// 1. Register plugin entry
await registerAofPlugin(pluginJsonPath);

// 2. Detect existing memory plugin
const memInfo = await detectMemoryPlugin();

// 3. Configure AOF as memory plugin (disables current holder)
await configureAofAsMemoryPlugin(memInfo.slotHolder);

// 4. Set plugin load path
await openclawConfigSet("plugins.load.paths", [installDir]);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `~/.openclaw/extensions/aof/` (deploy-plugin.sh) | `plugins.load.paths` pointing to source | Already in place | Installer must handle both discovery patterns |
| `~/.openclaw/aof/` data dir (DEFAULT_DATA_DIR in plugin.ts) | `~/.aof/` independent home dir | Phase 6 decision | Must migrate data, update `dataDir` config |
| Direct JSON editing (integration.ts) | `openclaw config set/get` CLI (openclaw-cli.ts) | Phase 6 decision | More robust, validates config |
| Manual `deploy:plugin` script | `curl \| sh` installer | Phase 6 | Single command install |
| No version tracking | `.version` file in `~/.aof/` | Phase 6 | Enables upgrade detection |

**Deprecated/outdated:**
- `integration.ts` direct JSON editing: Superseded by `openclaw-cli.ts` CLI approach. Keep the file for backward compatibility but do not use for new installations.
- `deploy-plugin.sh`: Development tool for the developer, not for end users. Installer replaces this for distribution.
- `GITHUB_REPO = "aof/aof"`: Placeholder, must be replaced with `"demerzel-ops/aof"`.

## Open Questions

1. **Data migration from ~/.openclaw/aof/ to ~/.aof/**
   - What we know: Current plugin.ts defaults to `~/.openclaw/aof/`, new installs should use `~/.aof/`
   - What's unclear: Should the installer move data, create a symlink, or update the config to point to the old location?
   - Recommendation: Move data to `~/.aof/` and update `plugins.entries.aof.config.dataDir` via `openclaw config set`. Print clear message about the migration.

2. **package-lock.json in tarball**
   - What we know: `build-tarball.mjs` does not include `package-lock.json`. `npm ci` requires it.
   - What's unclear: Whether the tarball should include it or whether `npm install` (without lockfile) is acceptable.
   - Recommendation: Add `package-lock.json` to the tarball's required files in `build-tarball.mjs` for reproducible installs.

3. **Native module build dependencies**
   - What we know: `better-sqlite3` and `hnswlib-node` require compilation. Node >= 22 on macOS includes basic build tools, but Linux may need `build-essential`.
   - What's unclear: Whether to check for build tools (python3, make, gcc/g++) as prerequisites.
   - Recommendation: Add a soft check for build tools. If missing, warn but attempt `npm ci` anyway -- npm will produce a clear error message if compilation fails.

4. **Plugin load path vs extensions path**
   - What we know: Current config uses `plugins.load.paths: ["/Users/xavier/Projects/aof"]` to load AOF from the development directory. The installer will place code at `~/.aof/`.
   - What's unclear: Should the installer add to the existing paths array or replace it?
   - Recommendation: Check if an AOF-pointing entry already exists in `plugins.load.paths`. If so, update it. If not, add `~/.aof`. Use `openclaw config set` for this.

5. **Which agent skills reference `aof`?**
   - What we know: The `"aof"` skill is listed in nearly every agent's `skills` array in openclaw.json. The skill files live in `skills/aof/` within the AOF source.
   - What's unclear: Whether the installer needs to configure skill discovery paths or if skills are auto-discovered from the plugin.
   - Recommendation: Research whether skills are loaded from the plugin directory automatically. If not, may need to add skill path configuration.

## Sources

### Primary (HIGH confidence)
- **Existing codebase** (`/Users/xavier/Projects/aof/src/packaging/`) -- All TypeScript modules read directly
- **openclaw.json** (`/Users/xavier/.openclaw/openclaw.json`) -- Actual plugin configuration examined
- **build-tarball.mjs** (`/Users/xavier/Projects/aof/scripts/build-tarball.mjs`) -- CI tarball creation
- **release.yml** (`/Users/xavier/Projects/aof/.github/workflows/release.yml`) -- CI pipeline
- **package.json** (`/Users/xavier/Projects/aof/package.json`) -- Repository URL `demerzel-ops/aof`

### Secondary (MEDIUM confidence)
- **nvm install.sh** (https://github.com/nvm-sh/nvm) -- Function-wrapped pattern for curl | sh safety
- **Shell installer best practices** -- Verified across multiple community sources

### Tertiary (LOW confidence)
- **Build tools requirement for native modules** -- Based on general knowledge of better-sqlite3 and hnswlib-node; specific failure modes on minimal Linux not verified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All components examined directly in codebase
- Architecture: HIGH - Patterns derived from existing code + established installer conventions
- Pitfalls: HIGH - Most pitfalls identified from actual code inspection (stubs, placeholders, data path mismatch)
- Open questions: MEDIUM - Data migration strategy needs user input; native module dependencies need testing

**Research date:** 2026-02-26
**Valid until:** 2026-03-26 (stable domain, code changes are under project control)
