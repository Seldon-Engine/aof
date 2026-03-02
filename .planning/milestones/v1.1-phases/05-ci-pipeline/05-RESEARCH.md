# Phase 5: CI Pipeline - Research

**Researched:** 2026-02-26
**Domain:** GitHub Actions CI/CD, release automation, conventional changelog
**Confidence:** HIGH

## Summary

AOF already has most of the release infrastructure in place: `release-it` v19.2.4 with `@release-it/conventional-changelog` v10, `commitlint` with conventional config, and `simple-git-hooks` for commit message enforcement. The existing `.release-it.json` configures version bumping, tag creation, and GitHub Release creation -- but `infile` is set to `false`, so CHANGELOG.md is not yet being written. Two GitHub Actions workflows already exist (docs deployment and a disabled e2e test scaffold), but neither covers CI validation or release artifact packaging.

The work boils down to three deliverables: (1) a CI workflow that runs typecheck + build + test on PRs and pushes to main, (2) a release workflow triggered by tag push that runs the test suite and uploads a tarball to the existing GitHub Release, and (3) updating the release-it config to write CHANGELOG.md via the `infile` option.

**Primary recommendation:** Create two new workflow files (`ci.yml` and `release.yml`), a tarball build script, and update `.release-it.json` to set `infile: "CHANGELOG.md"`. The existing release-it + conventional-changelog stack handles everything else.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Trigger on push to main AND on PRs targeting main
- Skip draft PRs -- only run when PR is marked ready for review
- Node version matrix: 22 and 23
- Ubuntu runners only (pure JS, no native deps)
- Cache npm dependencies (actions/cache or setup-node built-in cache)
- Release triggered by tag push (e.g., `git tag v1.2.0 && git push --tags`)
- Version numbers derived from conventional commits (fix=patch, feat=minor, breaking=major)
- Use release-it for version bump, changelog generation, and GitHub Release creation
- release-it runs locally: bumps version, updates CHANGELOG.md, commits, creates tag -- then CI picks up the tag push
- Release workflow runs full test suite before publishing artifacts (safety net)
- Tarball contains: built JS + package.json + README (production files only, no source/tests/dev deps)
- Tarball named by version only: `aof-v1.2.0.tar.gz` (no platform suffix -- pure JS)
- Changelog auto-grouped by conventional commit type: Features, Fixes, Breaking Changes
- CHANGELOG.md committed by release-it locally before tag push (not by CI)
- Branch protection requires CI status checks to pass before merge
- GitHub default notifications only -- no extra webhooks
- Release build failures require manual investigation and retry (no auto-retry)

### Claude's Discretion
- Exact GitHub Actions workflow structure and job naming
- setup-node cache strategy details
- release-it plugin configuration
- Tarball build script implementation

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CI-01 | GitHub Actions workflow runs typecheck, build, and tests on every PR to main | CI workflow with `on: push/pull_request` triggers, Node 22/23 matrix, `npm run typecheck && npm run build && npm test` steps |
| CI-03 | Manual release workflow runs release-it, creates GitHub Release with changelog | Release-it runs locally (already configured). CI release workflow triggered by `on: push: tags: ['v*']` runs tests and uploads tarball artifact to the GitHub Release that release-it already created |
| CI-04 | CHANGELOG.md is persisted in repo and updated on each release | Set `infile: "CHANGELOG.md"` in `.release-it.json` plugin config; release-it commits the file locally before tag push |
</phase_requirements>

## Standard Stack

### Core
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| GitHub Actions | N/A (platform) | CI/CD platform | Project already on GitHub (d0labs/aof), zero additional tooling |
| actions/checkout | v6 | Repository checkout | Current recommended version (released Jan 2026) |
| actions/setup-node | v4 | Node.js setup + npm cache | v4 is the stable LTS; v6 changed npm auto-caching behavior that may cause issues |
| release-it | ^19.2.4 | Version bump, tag, GitHub Release | Already installed and configured in project |
| @release-it/conventional-changelog | ^10.0.5 | Changelog generation from conventional commits | Already installed; needs `infile` config change |

### Supporting
| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| actions/upload-artifact | v4 | Upload build artifacts | Upload tarball as workflow artifact (backup) |
| softprops/action-gh-release | v2 | Upload assets to GitHub Release | Attach tarball to existing GitHub Release created by release-it |
| tar (system) | N/A | Create release tarball | Build `aof-v*.tar.gz` from dist + production files |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| softprops/action-gh-release | `gh release upload` via CLI | gh CLI is pre-installed on runners but softprops handles edge cases (release not found, retry) more gracefully |
| actions/setup-node v4 | actions/setup-node v6 | v6 auto-enables caching when `packageManager` field is set in package.json; v4 gives explicit `cache: 'npm'` control which is more predictable |
| npm ci | npm install | `npm ci` is correct for CI -- it uses lockfile exactly, is faster, and fails on lockfile mismatch |

**Installation:**
No new npm packages needed. All dependencies already exist in the project.

## Architecture Patterns

### Recommended Workflow Structure
```
.github/
  workflows/
    ci.yml          # PR/push validation (typecheck, build, test)
    release.yml     # Tag-push release (test, build tarball, upload)
    docs.yml        # Existing docs deployment (unchanged)
    e2e-tests.yml   # Existing disabled e2e scaffold (unchanged)
```

### Pattern 1: CI Validation Workflow
**What:** Single workflow with one job that runs typecheck, build, and tests across a Node version matrix.
**When to use:** Every push to main and every non-draft PR targeting main.
**Example:**
```yaml
# Source: GitHub Actions docs + project analysis
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  validate:
    if: github.event.pull_request.draft != true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [22, 23]
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
```

### Pattern 2: Release Workflow (Tag-Triggered)
**What:** Workflow triggered by version tag push that runs full validation, builds a production tarball, and attaches it to the GitHub Release.
**When to use:** When release-it pushes a `v*` tag after local release process.
**Example:**
```yaml
# Source: GitHub Actions docs + release-it docs
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write  # Needed to upload release assets

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test

      # Extract version from tag
      - name: Extract version
        id: version
        run: echo "version=${GITHUB_REF_NAME}" >> "$GITHUB_OUTPUT"

      # Build production tarball
      - name: Build tarball
        run: node scripts/build-tarball.mjs ${{ steps.version.outputs.version }}

      # Attach tarball to existing GitHub Release
      - uses: softprops/action-gh-release@v2
        with:
          files: aof-${{ steps.version.outputs.version }}.tar.gz
```

### Pattern 3: Tarball Build Script
**What:** Node.js script that assembles production files into a versioned tarball.
**When to use:** Called by release workflow after successful build.
**Example:**
```javascript
// scripts/build-tarball.mjs
// Assembles: dist/ + package.json + README.md + prompts/ + skills/ + openclaw.plugin.json + index.ts
// into aof-v1.2.0.tar.gz
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2]; // e.g., "v1.2.0"
if (!version) { console.error('Usage: node build-tarball.mjs <version>'); process.exit(1); }

const staging = '.release-staging';
mkdirSync(staging, { recursive: true });

// Copy production files (matches "files" field in package.json)
const filesToInclude = ['dist', 'prompts', 'skills', 'index.ts', 'openclaw.plugin.json', 'README.md', 'package.json', 'LICENSE'];
for (const f of filesToInclude) {
  cpSync(f, join(staging, f), { recursive: true });
}

// Create tarball
const tarball = `aof-${version}.tar.gz`;
execSync(`tar -czf ${tarball} -C ${staging} .`);

// Cleanup
execSync(`rm -rf ${staging}`);
console.log(`Created ${tarball}`);
```

### Pattern 4: release-it CHANGELOG.md Configuration
**What:** Update `.release-it.json` to write CHANGELOG.md file.
**When to use:** Permanent config change -- enables CI-04.
**Example:**
```json
{
  "plugins": {
    "@release-it/conventional-changelog": {
      "infile": "CHANGELOG.md",
      "header": "# Changelog",
      "preset": {
        "name": "conventionalcommits",
        "types": [
          { "type": "feat",     "section": "Features" },
          { "type": "fix",      "section": "Bug Fixes" },
          { "type": "perf",     "section": "Performance" },
          { "type": "refactor", "section": "Refactor" },
          { "type": "test",     "section": "Tests" },
          { "type": "docs",     "section": "Documentation" }
        ]
      }
    }
  }
}
```

### Anti-Patterns to Avoid
- **Running release-it in CI:** The user explicitly decided release-it runs locally. CI only validates and uploads artifacts. Running release-it in CI would duplicate GitHub Release creation and cause conflicts.
- **Using `actions/create-release`:** This action is archived/deprecated. release-it already creates the GitHub Release; CI just needs to attach the tarball via `softprops/action-gh-release`.
- **Caching `node_modules/`:** Never cache `node_modules` directly -- cache the npm download cache via `setup-node`'s `cache: 'npm'`. Native addons must be compiled per-platform.
- **Using `npm install` instead of `npm ci`:** `npm ci` is faster, reproducible, and fails on lockfile drift -- always use it in CI.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Version bumping | Custom version script | release-it | Already configured, handles git tag + GitHub Release + conventional changelog |
| Changelog generation | Custom commit parser | @release-it/conventional-changelog | Parses conventional commits, groups by type, handles CHANGELOG.md file writing |
| GitHub Release creation | Custom API calls | release-it `github.release: true` | Already configured, handles auth via `gh auth token` |
| Tarball asset upload | Custom `gh release upload` | softprops/action-gh-release@v2 | Handles edge cases, retries, and file glob patterns |
| npm caching in CI | Custom cache steps | actions/setup-node `cache: 'npm'` | Built-in, handles cache key generation and invalidation |
| Draft PR detection | Custom API check | `github.event.pull_request.draft` | Built-in GitHub Actions context variable |

**Key insight:** The project already has 90% of the release toolchain configured. The CI phase is primarily about writing two workflow YAML files and making a one-line config change to enable CHANGELOG.md generation.

## Common Pitfalls

### Pitfall 1: Native Addon Compilation Failures on CI
**What goes wrong:** `npm ci` fails because `hnswlib-node` requires C++ compilation via node-gyp, and `better-sqlite3` may fall back to compilation if prebuilds are missing for the Node version.
**Why it happens:** The CONTEXT notes "pure JS, no native deps" but AOF has three native dependencies: `better-sqlite3`, `hnswlib-node`, and `sqlite-vec`.
**How to avoid:** Ubuntu 24.04 runners include `build-essential`, `gcc`, `g++`, `make`, `python3`, and `cmake` -- all required for node-gyp. No extra setup steps needed. `better-sqlite3` ships prebuilds for Node 22/23 on Linux x64. `hnswlib-node` compiles from source but succeeds with the pre-installed toolchain. `sqlite-vec` ships pre-compiled (no node-gyp).
**Warning signs:** `npm ci` step fails with "gyp ERR!" errors. Fix: ensure `node-version` in matrix matches a version with prebuilds, or add `apt-get install build-essential` as a fallback (usually unnecessary).

### Pitfall 2: Shallow Clone Breaks Changelog Generation
**What goes wrong:** release-it (when run locally) or the release workflow can't generate a full changelog because git history is shallow.
**Why it happens:** `actions/checkout` defaults to `fetch-depth: 1` (single commit). If any workflow step needs commit history (e.g., for release notes verification), it will fail.
**How to avoid:** For the CI validation workflow, `fetch-depth: 1` is fine (tests don't need history). For the release workflow, the tests also don't need history -- but if you ever need to verify the changelog content, add `fetch-depth: 0`. Since release-it runs locally (where full history exists), this is not a current concern.
**Warning signs:** Changelog in GitHub Release body is empty or only contains the latest commit.

### Pitfall 3: Tag-Push Workflow Doesn't Trigger
**What goes wrong:** Pushing a tag doesn't trigger the release workflow.
**Why it happens:** GitHub Actions has specific rules for tag push events. If a tag is created as part of a push that also pushes commits, the behavior can vary. Also, if the tag is created via the GitHub API (as release-it does when `git.push: true`), the `GITHUB_TOKEN`-triggered events won't fire new workflows (to prevent infinite loops).
**How to avoid:** release-it pushes the tag via git (not the API), so standard `on: push: tags` triggers will work. The config has `"push": true, "pushRepo": "origin"` which uses git push. However, if `GITHUB_TOKEN` is used to push the tag (e.g., in CI), it won't trigger. Since release-it runs locally with the user's SSH key, this is not an issue.
**Warning signs:** Tag appears on GitHub but no release workflow run is visible. Check: was the tag pushed via git or created via API?

### Pitfall 4: softprops/action-gh-release Creates Duplicate Release
**What goes wrong:** The release workflow creates a NEW GitHub Release instead of attaching to the one release-it already created.
**Why it happens:** `softprops/action-gh-release` creates a release if one doesn't exist for the tag. If release-it's GitHub Release creation is delayed or failed, the action may create a duplicate.
**How to avoid:** By default, `softprops/action-gh-release@v2` will update an existing release for the tag if one exists. This is the desired behavior -- it attaches files to the existing release. No special configuration needed; the default `update_existing: true` behavior handles this.
**Warning signs:** Two releases for the same version on the GitHub Releases page.

### Pitfall 5: Node 23 Is Not LTS
**What goes wrong:** Tests pass on Node 22 but fail on Node 23 due to experimental features or API changes.
**Why it happens:** Node 23 is a current/odd-numbered release, not LTS. It may have breaking changes or experimental features enabled by default.
**How to avoid:** The user explicitly chose Node 22 and 23 for the matrix. Use `fail-fast: false` in the matrix strategy so a Node 23 failure doesn't mask a Node 22 success. Node 22 is the primary target (LTS); Node 23 is forward-compatibility testing.
**Warning signs:** CI is red but only on Node 23. Investigate whether the failure is a real bug or a Node 23 incompatibility.

### Pitfall 6: Concurrency Cancellation Kills Valid Runs
**What goes wrong:** A new push cancels an in-progress CI run for the same branch, causing false-negative results.
**Why it happens:** `cancel-in-progress: true` is common for CI workflows to save runner minutes.
**How to avoid:** Use concurrency groups scoped to the branch: `group: ci-${{ github.ref }}`. For the release workflow, do NOT use `cancel-in-progress` -- release runs should always complete. Use `group: release-${{ github.ref }}` with `cancel-in-progress: false`.
**Warning signs:** CI runs are frequently cancelled on active PRs.

## Code Examples

### CI Workflow (Full)
```yaml
# Source: GitHub Actions docs, verified against project structure
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  validate:
    name: Node ${{ matrix.node-version }}
    if: github.event.pull_request.draft != true
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node-version: [22, 23]
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Build
        run: npm run build

      - name: Test
        run: npm test
```

### Release Workflow (Full)
```yaml
# Source: GitHub Actions docs + softprops/action-gh-release docs
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: write

jobs:
  release:
    name: Build & Publish
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Build
        run: npm run build

      - name: Test
        run: npm test

      - name: Extract version
        id: version
        run: echo "version=${GITHUB_REF_NAME}" >> "$GITHUB_OUTPUT"

      - name: Build release tarball
        run: node scripts/build-tarball.mjs ${{ steps.version.outputs.version }}

      - name: Upload tarball to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: aof-${{ steps.version.outputs.version }}.tar.gz
```

### release-it Config Change for CHANGELOG.md
```json
// .release-it.json — change infile from false to "CHANGELOG.md"
// Before: "infile": false
// After:
{
  "plugins": {
    "@release-it/conventional-changelog": {
      "infile": "CHANGELOG.md",
      "header": "# Changelog"
    }
  }
}
```

### Draft PR Skip Pattern
```yaml
# Source: GitHub Actions docs
# The `if` condition on the job level skips draft PRs.
# The `types` list on the trigger ensures the workflow fires when a draft is marked ready.
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  validate:
    if: github.event.pull_request.draft != true
    # For push events (not PRs), github.event.pull_request is null,
    # so the condition evaluates to true and the job runs.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| actions/checkout@v4 | actions/checkout@v6 | Jan 2026 | Improved credential security (stores in $RUNNER_TEMP) |
| actions/setup-node@v3 | actions/setup-node@v4 | Stable LTS | Built-in cache support, reliable for npm ci |
| actions/create-release | softprops/action-gh-release@v2 | 2023+ | Official action is archived; softprops is the community standard |
| actions/upload-release-asset | softprops/action-gh-release@v2 | 2023+ | Official action is archived; softprops combines create+upload |
| ubuntu-22.04 | ubuntu-24.04 (ubuntu-latest) | Dec 2024 | New default; includes updated toolchains |
| release-it < v17 | release-it v19 | 2024+ | ESM-first, improved plugin API |

**Deprecated/outdated:**
- `actions/create-release`: Archived, replaced by `softprops/action-gh-release` or `gh release create`
- `actions/upload-release-asset`: Archived, merged into `softprops/action-gh-release`
- `ubuntu-20.04` / `ubuntu-22.04` as defaults: `ubuntu-latest` is now `ubuntu-24.04`

## Open Questions

1. **Node 23 prebuild availability for better-sqlite3**
   - What we know: better-sqlite3 ships prebuilds for Node 22 LTS on Linux x64. Node 23 is not LTS.
   - What's unclear: Whether prebuilds exist for Node 23 specifically, or if it falls back to node-gyp compilation.
   - Recommendation: Accept compilation fallback; Ubuntu runners have all build tools. Test this in the first CI run -- if Node 23 npm ci fails, investigate prebuild status.

2. **release-it GitHub Release vs CI race condition**
   - What we know: release-it creates the GitHub Release (with changelog body) via `gh auth token`. The release workflow triggers on tag push and tries to upload the tarball.
   - What's unclear: Whether the GitHub Release is guaranteed to exist by the time the release workflow reaches the upload step (network timing).
   - Recommendation: `softprops/action-gh-release@v2` handles this gracefully -- if the release doesn't exist yet, it creates one; if it does, it updates it. The upload step runs after tests (~2-5 min), giving release-it ample time to finish.

3. **test-lock.sh `flock` on Linux**
   - What we know: The test script uses `flock` for serialization. This works on Linux (GNU coreutils).
   - What's unclear: Whether flock works correctly in the GitHub Actions environment.
   - Recommendation: `flock` is available on Ubuntu runners (part of `util-linux`). In CI, test concurrency isn't an issue (single runner), but the script will work correctly. Use `npm test` directly (which calls `test-lock.sh`).

## Sources

### Primary (HIGH confidence)
- Project analysis: `/Users/xavier/Projects/AOF/package.json`, `.release-it.json`, `vitest.config.ts`, `tsconfig.json`
- Project analysis: Existing `.github/workflows/docs.yml` and `e2e-tests.yml`
- [actions/checkout README](https://github.com/actions/checkout) - v6 confirmed as latest (Jan 2026)
- [actions/setup-node README](https://github.com/actions/setup-node) - v4 stable, v6 available with auto-caching
- [release-it/conventional-changelog README](https://github.com/release-it/conventional-changelog) - `infile` configuration verified
- [release-it changelog docs](https://github.com/release-it/release-it/blob/main/docs/changelog.md) - Verified `infile` writes CHANGELOG.md
- [Ubuntu 24.04 runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) - Build tools (gcc, g++, make, python3, cmake) confirmed pre-installed

### Secondary (MEDIUM confidence)
- [softprops/action-gh-release](https://github.com/softprops/action-gh-release) - v2 is current, handles update-existing by default
- [GitHub Actions documentation](https://docs.github.com/en/actions) - Workflow syntax, concurrency groups, permissions
- [better-sqlite3 prebuild discussion](https://github.com/WiseLibs/better-sqlite3/discussions/1289) - Prebuilt binaries available for LTS Node versions

### Tertiary (LOW confidence)
- Node 23 prebuild availability for better-sqlite3 and hnswlib-node: Unverified, needs CI run to confirm

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All tools already installed and configured in the project; just need workflow YAML files
- Architecture: HIGH - Standard GitHub Actions patterns with well-documented actions
- Pitfalls: HIGH - Native deps on Ubuntu runners verified; race conditions well-understood
- release-it config: HIGH - `infile` option documented in official README with clear examples

**Research date:** 2026-02-26
**Valid until:** 2026-03-26 (stable domain -- GitHub Actions and release-it change slowly)
