# Technology Stack

**Project:** AOF v1.3 Seamless Upgrade
**Researched:** 2026-03-03
**Scope:** Stack additions/changes for config migration, DAG-as-default, smoke tests, rollback safety, and release validation

## Executive Assessment

**No new dependencies required.** The existing stack already contains every library needed. The v1.3 milestone is an integration and hardening milestone, not a greenfield feature build. The work is writing new migration code, new test suites, and new release hooks -- all using tools already in the project.

## Existing Stack (Confirmed Current)

| Technology | Installed | Purpose | Status for v1.3 |
|------------|-----------|---------|------------------|
| yaml | 2.8.2 | YAML parse/stringify for project.yaml migration | Sufficient |
| zod | 3.25.76 | Schema validation for migrated config | Sufficient |
| vitest | 3.2.4 | Smoke and integration test runner | Sufficient |
| release-it | 19.2.4 | Release pipeline with hook lifecycle | Sufficient |
| @release-it/conventional-changelog | (installed) | Changelog generation from conventional commits | Sufficient |
| write-file-atomic | 7.x | Atomic file writes for rollback-safe operations | Sufficient |
| gray-matter | 4.0.3 | YAML frontmatter parsing for task migration | Sufficient |
| TypeScript | 5.7.x | Type safety across migration code | Sufficient |
| Node.js | 22 (pinned) | Runtime | Sufficient |

**Confidence:** HIGH -- versions verified from installed `node_modules`.

## What Each v1.3 Feature Needs

### 1. Config Migration (project.yaml gets workflowTemplates)

**Existing infrastructure:** The migration framework at `src/packaging/migrations.ts` already provides:
- `Migration` interface with `up(ctx)` / `down(ctx)` lifecycle
- `runMigrations()` with version comparison, history tracking, and ordered execution
- Migration history persisted to `.aof/migrations.json`
- Forward and reverse migration support

**Existing YAML tooling:** The `yaml` library (v2.8.2) is already used throughout the codebase for:
- `src/projects/migration.ts` -- YAML frontmatter parse/stringify for task migration
- `src/projects/manifest.ts` -- project.yaml write via `stringifyYaml`
- `src/cli/commands/task-create-workflow.ts` -- project.yaml read via `parseYaml`

**What to build (no new deps):**
- A new `Migration` entry (e.g., `003-add-workflow-templates`) that:
  1. Reads each project's `project.yaml`
  2. Parses with `yaml` library
  3. Adds empty `workflowTemplates: {}` section if absent
  4. Writes back with `stringifyYaml` preserving formatting (yaml@2 handles this natively)
  5. `down()` removes the `workflowTemplates` key
- The `WorkflowConfig` to `WorkflowDefinition` conversion already exists in `gate-to-dag.ts` -- reuse for converting legacy `workflow.gates` into a default template entry

**Stack decision:** Use `yaml` library's `parseDocument()` API (not `parse()`) for the config migration because `parseDocument()` preserves comments and formatting, which matters when editing user config files. This is available in yaml@2 already installed.

**Why not add a dedicated config migration library (like `kyrage` or custom)?** The existing `Migration` framework is purpose-built and lightweight. Adding another migration framework creates two systems to maintain. The existing framework handles versioning, history, up/down, and ordering -- everything needed.

### 2. DAG Workflows as Default for New Tasks

**Existing infrastructure:**
- `src/store/task-store.ts` create() already accepts `workflow?: { definition, templateName }`
- `src/cli/commands/task-create-workflow.ts` resolves templates from `project.yaml`
- `src/schemas/project.ts` already defines `workflowTemplates: z.record(TemplateNameKey, WorkflowDefinition).optional()`
- `src/schemas/workflow.ts` is already marked `@deprecated` with "Will be removed in v1.3"

**What to build (no new deps):**
- Add a `defaultWorkflow` field to the ProjectManifest schema (string key referencing a workflowTemplates entry)
- Modify task create path to auto-attach the default workflow when no explicit workflow is specified
- The config migration (above) seeds a sensible default template

**Stack decision:** This is a schema addition to the existing Zod schema in `src/schemas/project.ts`, plus a lookup in the task creation path. Zero new dependencies.

### 3. Smoke/Integration Tests for the Upgrade Path

**Existing infrastructure:**
- vitest 3.2.4 with two configs: root `vitest.config.ts` (unit) and `tests/vitest.e2e.config.ts` (e2e)
- E2E tests use tmpdir-based fixtures with `beforeEach`/`afterEach` cleanup (see `src/projects/__tests__/migration.test.ts`)
- The packaging migration tests (`src/packaging/__tests__/migrations.test.ts`) demonstrate the pattern: create temp dir, run migrations, assert state
- The project migration tests (`src/projects/__tests__/migration.test.ts`) demonstrate full upgrade flow: create legacy layout, migrate, verify, rollback, verify

**What to build (no new deps):**

A dedicated vitest config for upgrade smoke tests:

```typescript
// tests/vitest.upgrade.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/upgrade/**/*.test.ts"],
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    bail: 1,
  },
});
```

**Test strategy using existing patterns:**

| Test Category | Pattern | Example |
|--------------|---------|---------|
| Config migration roundtrip | tmpdir + writeFile + runMigrations + readFile + assert | Pre-v1.2 project.yaml -> v1.3 with workflowTemplates |
| Gate-to-DAG preservation | tmpdir + create legacy task + load via TaskStore + assert workflow field | Task with gate fields migrates to DAG on read |
| DAG default attachment | tmpdir + create task without workflow + assert default workflow attached | New task gets project's defaultWorkflow |
| Rollback safety | tmpdir + migrate + rollback + assert original state | Config, tasks, state all restored |
| Tarball integrity | build tarball + extract to tmpdir + assert required files + npm ci + health check | All production files present, dependencies install |
| Fresh install path | tmpdir + run installer setup logic + assert _inbox created + project.yaml valid | Clean install produces valid state |
| Upgrade from v1.2 | tmpdir + create v1.2 state + run migrations + assert v1.3 state | v1.2 data preserved, new fields added |

**Why not add a separate test framework?** vitest already handles everything. The existing e2e test patterns (tmpdir fixtures, sequential execution via forks, bail-on-failure) are exactly what upgrade smoke tests need. Adding a separate framework (like shellspec or bats for shell testing) would add complexity without benefit since the critical upgrade logic runs in Node.js, not in the shell installer.

**npm test script addition:**

```json
"test:upgrade": "./scripts/test-lock.sh run --config tests/vitest.upgrade.config.ts"
```

### 4. Rollback Safety Mechanisms

**Existing infrastructure:**
- `src/projects/migration.ts` -- full rollback with `rollbackMigration()`: finds backup, restores dirs, handles timestamps
- `src/packaging/installer.ts` -- `update()` with automatic backup/restore on failure
- `scripts/install.sh` -- shell-level backup of data dirs before tarball extraction, restore on failure
- `write-file-atomic` -- atomic file writes (write to temp, rename over original)
- `src/packaging/migrations.ts` -- migration `down()` for reversible migrations

**What to build (no new deps):**

The rollback safety for v1.3 is a combination of:

1. **Config backup before migration:** Copy `project.yaml` to `project.yaml.pre-v1.3` before modifying
2. **Reversible migration with `down()`:** The config migration must implement `down()` to strip `workflowTemplates` and `defaultWorkflow`
3. **Atomic config writes:** Use `write-file-atomic` (already a dependency) instead of raw `writeFile` for project.yaml updates
4. **Version gating:** Record the migration in `.aof/migrations.json` so it never re-runs

**Why not add a transactional filesystem library (like `fs-jetpack` or `graceful-fs`)?** The existing `write-file-atomic` handles the critical path (atomic rename on POSIX). The backup-then-migrate-then-verify pattern in `projects/migration.ts` is battle-tested within this codebase. A transactional layer adds abstraction without improving safety beyond what atomic rename provides on a single-machine deployment.

**Rollback command pattern:**

```typescript
// In migration down():
async down(ctx: MigrationContext) {
  // For each project's project.yaml:
  // 1. Load document with yaml.parseDocument() (preserves comments)
  // 2. Delete 'workflowTemplates' and 'defaultWorkflow' keys
  // 3. Write back atomically
}
```

### 5. Release Validation Before Publishing

**Existing infrastructure:**
- `.release-it.json` already has `before:init` hooks: `["npm run typecheck", "npm test"]`
- `scripts/build-tarball.mjs` validates required files exist before packaging
- `.github/workflows/release.yml` runs typecheck, build, test before creating tarball
- `.github/workflows/ci.yml` runs on PRs with Node 22 and 23

**What to build (no new deps):**

Extend the existing release-it hooks and CI workflow:

```jsonc
// .release-it.json additions
{
  "hooks": {
    "before:init": [
      "npm run typecheck",
      "npm test",
      "npm run test:upgrade"  // NEW: run upgrade smoke tests
    ],
    "after:bump": [
      "npm run build",
      "node scripts/build-tarball.mjs v${version}",
      "node scripts/verify-tarball.mjs v${version}"  // NEW: verify tarball contents
    ]
  }
}
```

**New tarball verification script** (`scripts/verify-tarball.mjs`):

```javascript
// Extracts tarball to tmpdir, verifies:
// 1. All required files present (dist/, package.json, etc.)
// 2. npm ci --production succeeds
// 3. dist/cli/index.js is executable
// 4. Version in package.json matches tag
// 5. No dev-only files leaked (tsconfig, vitest.config, etc.)
// 6. Tarball size within expected range (catches accidental bloat)
```

**CI workflow enhancement** (`.github/workflows/release.yml`):

```yaml
# Add between "Test" and "Build release tarball":
- name: Run upgrade smoke tests
  run: npm run test:upgrade

# Add after "Build release tarball":
- name: Verify tarball
  run: node scripts/verify-tarball.mjs ${{ steps.version.outputs.version }}
```

**Why not add a separate release validation tool (like semantic-release)?** release-it is already wired in, has the hook lifecycle needed, and the team is familiar with it. semantic-release has a different philosophy (fully automated releases from commit messages) that conflicts with the explicit `release:minor` / `release:patch` commands already in package.json. Switching would be a lateral move with churn and no benefit.

## Stack: What NOT to Add

| Considered | Why Not |
|-----------|---------|
| `semver` npm package | The existing `compareVersions()` in `src/packaging/migrations.ts` handles the simple cases needed (X.Y.Z comparison). Semver's prerelease/range features aren't needed for migration version gating. |
| `fs-jetpack` / `fs-extra` | `write-file-atomic` + Node's built-in `fs/promises` cover all needs. The codebase is already consistent with these. |
| `shellspec` / `bats` (shell test frameworks) | The installer's shell portion is thin (download + extract + hand off to Node.js). Testing the Node.js setup logic with vitest is more valuable and already working. |
| `kyrage` / `umzug` (migration frameworks) | The existing `Migration` framework in `src/packaging/migrations.ts` is purpose-built and lightweight. Adding another creates two migration systems. |
| `semantic-release` | Already using release-it with conventional-changelog plugin. Switching is churn. |
| `ajv` (JSON Schema validator) | Zod is the validation layer. Adding JSON Schema validation creates a parallel system. |
| `deep-diff` / `diff` | Config migration doesn't need diffing -- it's additive (add workflowTemplates key). |
| `inquirer` (additional prompts) | Already have `@inquirer/prompts`. The upgrade path should be non-interactive (`--auto` flag). |

## Integration Points

### Migration Registration

New v1.3 migrations should be registered in a central registry file and imported by the installer setup:

```
src/packaging/migrations/
  index.ts           -- exports all migrations in order
  001-init-schema.ts -- (existing, if any)
  002-project-layout.ts -- (existing, from v1.1)
  003-workflow-templates.ts -- NEW: adds workflowTemplates to project.yaml
  004-default-workflow.ts -- NEW: sets defaultWorkflow on projects that had workflow.gates
```

### Schema Changes

```
src/schemas/project.ts:
  + defaultWorkflow: z.string().optional()  // references key in workflowTemplates

src/schemas/workflow.ts:
  - Remove @deprecated tag, replace with full removal
  - Move any remaining gate types to migration-only code
```

### Test Suite Organization

```
tests/
  upgrade/
    config-migration.test.ts    -- project.yaml migration roundtrips
    gate-to-dag-upgrade.test.ts -- legacy task workflows convert correctly
    dag-default.test.ts         -- new tasks get default workflow
    rollback.test.ts            -- migration reversal works
    tarball-integrity.test.ts   -- built tarball contains required files
    fresh-install.test.ts       -- clean install from scratch
```

### Release Pipeline Order

```
1. npm run typecheck           (existing, before:init)
2. npm test                    (existing, before:init)
3. npm run test:upgrade        (NEW, before:init)
4. npm run build               (NEW location, after:bump)
5. build-tarball.mjs           (NEW location, after:bump)
6. verify-tarball.mjs          (NEW, after:bump)
7. git tag + push              (release-it automatic)
8. GitHub Release + upload     (release-it/GitHub Actions)
```

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Config migration | Existing Migration framework + yaml parseDocument | New YAML-specific migration tool | Already have a working migration framework; adding another is duplication |
| Test runner | vitest (existing) | Jest, bats, shellspec | vitest is already configured, familiar, and handles the tmpdir fixture pattern well |
| Release pipeline | release-it hooks (existing) | GitHub Actions-only validation | release-it hooks run locally too (via `npm run release:dry`), providing faster feedback |
| Atomic writes | write-file-atomic (existing) | fs-extra, custom rename wrapper | Already a dependency, already used in task-store.ts |
| YAML handling | yaml@2 parseDocument (existing) | js-yaml, custom parser | yaml@2 already installed, parseDocument preserves comments |

## Installation

No new packages to install. Run existing:

```bash
npm ci
```

## Version Verification Commands

```bash
# Verify all required tools are at expected versions
node -e "console.log('yaml:', require('./node_modules/yaml/package.json').version)"
# Expected: 2.8.x

node -e "console.log('vitest:', require('./node_modules/vitest/package.json').version)"
# Expected: 3.2.x

node -e "console.log('release-it:', require('./node_modules/release-it/package.json').version)"
# Expected: 19.2.x

node -e "console.log('zod:', require('./node_modules/zod/package.json').version)"
# Expected: 3.25.x
```

## Sources

- yaml@2 parseDocument API: verified via installed node_modules (v2.8.2)
- Existing migration framework: `src/packaging/migrations.ts` (read from codebase)
- Existing project migration: `src/projects/migration.ts` (read from codebase)
- Existing gate-to-DAG: `src/migration/gate-to-dag.ts` (read from codebase)
- release-it hooks: [release-it GitHub](https://github.com/release-it/release-it)
- release-it hook lifecycle: [release-it docs](https://github.com/release-it/release-it/blob/main/docs/configuration.md)
- vitest config: [vitest.dev](https://vitest.dev/guide/cli)
- Existing installer: `scripts/install.sh` (read from codebase)
- Existing release workflow: `.github/workflows/release.yml` (read from codebase)
- Existing tarball builder: `scripts/build-tarball.mjs` (read from codebase)
- write-file-atomic: already in package.json dependencies
- Existing test patterns: `src/packaging/__tests__/migrations.test.ts`, `src/projects/__tests__/migration.test.ts`
