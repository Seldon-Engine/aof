# Phase 19: Verification & Smoke Tests - Research

**Researched:** 2026-03-03
**Domain:** CLI smoke testing, upgrade scenario testing, tarball verification
**Confidence:** HIGH

## Summary

Phase 19 implements three distinct verification artifacts: a `bd smoke` CLI command, a Vitest-based upgrade scenario test suite, and a tarball verification script. All three share a common pattern -- they validate the state of an AOF installation against expected invariants -- but differ in when they run (post-install, CI test phase, pre-release) and how they are invoked (CLI subcommand, `vitest run`, standalone script).

The codebase already provides all the building blocks needed. Schema validators (Zod), migration history readers (`getMigrationHistory`), task store operations, org chart loaders, and version readers are all exported and tested. The smoke command needs only to compose these existing functions into a checklist runner. The upgrade test suite follows the established pattern from `migrations-impl.test.ts` (temp directories, fixture YAML, assert end-state). The tarball verification script extends the existing `build-tarball.mjs` workflow in `scripts/`.

**Primary recommendation:** Compose existing APIs into a thin smoke runner; use static YAML fixtures for upgrade scenarios; keep the tarball verification script as a standalone Node.js script in `scripts/` for consistency with `build-tarball.mjs`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- `bd smoke` is a standalone CLI subcommand (not part of daemon health)
- Checks: version string, schema validation, task store read, org chart read, migration status (from `.aof/migrations.json`), workflow templates validation
- Output: checklist format with pass/fail per check, exit code 0 if all pass, non-zero on any failure
- Must work without a running daemon -- reads files directly
- Vitest-based tests using fixture directories that simulate four scenarios
- Scenarios: fresh install (empty data dir), pre-v1.2 upgrade (gate-based tasks, no migrations), v1.2 upgrade (partial migrations), DAG-default (configured defaultWorkflow)
- Fixtures are static YAML files committed to the repo under test fixtures directory
- Tests exercise the actual migration runner and verify end-state
- Tarball verification is a standalone script (not vitest) -- runs against a built tarball
- Validates: extraction succeeds, `npm ci --production` completes, CLI boots (`bd --version`), version string matches package.json, package size under threshold
- Designed to run in CI between build and upload steps

### Claude's Discretion
- Exact check order in `bd smoke`
- Fixture directory structure and naming
- Tarball size threshold
- Whether tarball verification is shell script or Node.js
- Error message formatting

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| VERF-01 | `bd smoke` command runs post-install health checks (version, schema, task store, org chart, migration status, workflow templates) | Existing APIs: `readPackageVersion()` in setup.ts, `getMigrationHistory()` in migrations.ts, `ProjectManifest.parse()`, `OrgChart.parse()`, `FilesystemTaskStore` list(), `resolveDefaultWorkflow()`. All proven in tests. |
| VERF-02 | Upgrade smoke test suite validates fresh install, pre-v1.2 upgrade, v1.2 upgrade, and DAG default scenarios | Existing migration runner `runMigrations()` + `getAllMigrations()` pattern in setup.ts. Fixture pattern established in `migrations-impl.test.ts`. Vitest 3.x with temp dir pattern. |
| VERF-03 | Tarball verification script validates extraction, `npm ci --production`, CLI boot, version match, and size check before release upload | Existing `build-tarball.mjs` in scripts/. Release pipeline uses release-it with `before:init` hooks. Script complements existing build tooling. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | ^3.0.0 | Test runner for upgrade scenario suite | Already the project test framework |
| commander | ^14.0.3 | CLI command registration for `bd smoke` | Already the project CLI framework |
| zod | (project dep) | Schema validation in smoke checks | Already used for all schema validation |
| yaml | (project dep) | YAML parsing in smoke checks | Already used for project/org YAML parsing |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:child_process | built-in | `execSync`/`execFileSync` for tarball verification script | CLI boot test, npm ci |
| node:fs/promises | built-in | File reads in smoke command | All file-based checks |
| write-file-atomic | (project dep) | Not needed for this phase | Smoke checks are read-only |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Node.js tarball script | Shell script (bash) | Node.js is more portable, matches `build-tarball.mjs` pattern, can read package.json natively; shell would be simpler but less maintainable |

**Installation:**
No new dependencies needed. All required libraries are already in the project.

## Architecture Patterns

### Recommended Project Structure
```
src/
  cli/
    commands/
      smoke.ts                    # bd smoke command (VERF-01)
      __tests__/
        smoke.test.ts             # Unit tests for smoke check logic
  packaging/
    __tests__/
      upgrade-scenarios.test.ts   # VERF-02 upgrade scenario suite
      __fixtures__/
        fresh-install/            # Empty data dir scenario
        pre-v1.2-upgrade/         # Gate-based tasks, no migrations.json
        v1.2-upgrade/             # Partial migrations (001, 002 applied)
        dag-default/              # Configured defaultWorkflow
scripts/
  verify-tarball.mjs              # VERF-03 tarball verification script
```

### Pattern 1: Smoke Check Runner (VERF-01)
**What:** A structured check runner that composes existing APIs into a diagnostic checklist
**When to use:** `bd smoke` command execution
**Example:**
```typescript
// Pattern from existing health.ts and setup.ts

interface SmokeCheck {
  name: string;
  run: (root: string) => Promise<SmokeResult>;
}

interface SmokeResult {
  pass: boolean;
  detail: string;
}

// Each check is a standalone function using existing APIs:
// - version: readPackageVersion(root) + compare with expected
// - schema: ProjectManifest.parse() on each project.yaml
// - taskStore: new FilesystemTaskStore(tasksDir).list()
// - orgChart: OrgChart.parse(loadOrgChartYaml(root))
// - migrations: getMigrationHistory(root)
// - workflows: validate workflowTemplates in project manifests
```

### Pattern 2: Fixture-Based Upgrade Scenarios (VERF-02)
**What:** Static YAML fixture directories + migration runner + assertion on end-state
**When to use:** Vitest upgrade scenario tests
**Example:**
```typescript
// Pattern from existing migrations-impl.test.ts
describe("Upgrade Scenarios", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-upgrade-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("fresh install: empty dir gets all migrations", async () => {
    // Copy fresh-install fixture to tmpDir
    // Run setup flow (wizard + migration003)
    // Assert: channel.json exists, no gate fields, version metadata set
  });

  it("pre-v1.2 upgrade: gate-based tasks get converted", async () => {
    // Copy pre-v1.2 fixture to tmpDir
    // Run migration runner with all migrations
    // Assert: all tasks have workflow fields, no gate fields
    //         migrations.json records 001, 002, 003
    //         defaultWorkflow set in project.yaml
  });
});
```

### Pattern 3: Tarball Verification Script (VERF-03)
**What:** Standalone Node.js script that validates a built tarball
**When to use:** CI pipeline between build and upload
**Example:**
```javascript
// Pattern from existing build-tarball.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const tarball = process.argv[2];
const MAX_SIZE_MB = 15; // Threshold for tarball size

// 1. Extract to temp dir
// 2. npm ci --production
// 3. Run CLI boot check: node dist/cli/index.js --version
// 4. Compare version string with package.json
// 5. Check tarball size < threshold
```

### Anti-Patterns to Avoid
- **Mocking migration runner in upgrade tests:** The CONTEXT.md explicitly says "tests exercise the actual migration runner." Use real `runMigrations()` with real fixture files, not mocks.
- **Making smoke checks depend on daemon:** The smoke command must work without a running daemon. Read files directly, do not connect to any HTTP endpoints.
- **Inlining fixture data in test files:** Fixtures should be static YAML files in the fixture directories, not string literals in test code. This makes them easy to inspect and update independently.
- **Using vitest for tarball verification:** The CONTEXT.md explicitly says the tarball script is standalone, not vitest. It runs against a built artifact, not source code.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Schema validation | Custom YAML field checkers | `ProjectManifest.parse()`, `OrgChart.parse()`, `AofConfig.parse()` | Zod schemas are already comprehensive and battle-tested |
| Migration history reading | Manual JSON parsing of migrations.json | `getMigrationHistory(aofRoot)` from `src/packaging/migrations.ts` | Already handles missing file, returns typed MigrationHistory |
| Version reading | Custom package.json parser | `readPackageVersion(dataDir)` from `src/cli/commands/setup.ts` | Already handles missing file, returns "0.0.0" fallback |
| Task store validation | Custom file scanning | `FilesystemTaskStore.list()` | Already handles all status directories, frontmatter parsing |
| Workflow template validation | Custom template parsing | `resolveWorkflowTemplate()` and `resolveDefaultWorkflow()` from `task-create-workflow.ts` | Already validated DAG, handles missing templates |
| YAML loading | Custom YAML reader | `import { parse } from "yaml"` + Zod `.parse()` | Project pattern, already used everywhere |

**Key insight:** Phase 19 is a composition phase, not a new-feature phase. Nearly every check the smoke command needs is already exported and tested. The value is in orchestrating these checks into a coherent verification flow.

## Common Pitfalls

### Pitfall 1: Smoke Command Depending on CWD
**What goes wrong:** Smoke command assumes it runs from the AOF root directory
**Why it happens:** Other commands use `program.opts()["root"]` but smoke might bypass it
**How to avoid:** Always resolve `root` from `program.opts()["root"]` (which defaults to `AOF_ROOT`). Pass root explicitly to every check function.
**Warning signs:** Tests pass locally but fail when run from a different directory.

### Pitfall 2: Fixture Directories Missing Required Subdirectories
**What goes wrong:** Migration runner fails because expected directories (Projects/, tasks/in-progress/) don't exist in fixtures
**Why it happens:** Static fixtures might be incomplete
**How to avoid:** Create complete fixture directory trees. The pre-v1.2 fixture needs: Projects/<project>/project.yaml, Projects/<project>/tasks/<status>/TASK-*.md. The fresh-install fixture can be truly empty (mkdir only).
**Warning signs:** "ENOENT: no such file or directory" in migration test output.

### Pitfall 3: Tarball Verification Script Exit Codes
**What goes wrong:** Script reports success even when a check fails
**Why it happens:** Node.js scripts default to exit code 0; individual step failures might not propagate
**How to avoid:** Use `process.exit(1)` explicitly on any failure. Use `execSync` which throws on non-zero exit. Wrap in try/catch with explicit failure reporting.
**Warning signs:** CI pipeline uploads broken tarballs.

### Pitfall 4: readPackageVersion in setup.ts is Private
**What goes wrong:** Trying to import `readPackageVersion` from setup.ts but it's not exported
**Why it happens:** The function is declared as a module-level function in setup.ts but may not have an `export` keyword
**How to avoid:** Check if the function is exported. If not, either: (a) extract it to a shared utility, or (b) re-implement the trivial version read in the smoke module (it's only 6 lines). The simplest approach: read package.json and extract version inline in the smoke check.
**Warning signs:** TypeScript compilation error on import.

### Pitfall 5: Fixture Files Must Use Correct Schema Version
**What goes wrong:** Upgrade scenario tests fail because fixture task files have wrong schemaVersion
**Why it happens:** Pre-v1.2 tasks should have `schemaVersion: 1` and gate fields. Post-migration tasks should have `schemaVersion: 2` (if that's what migrations produce).
**How to avoid:** Model fixtures exactly on what real data dirs look like at each version point. Refer to `migrations-impl.test.ts` fixtures for correct frontmatter format.
**Warning signs:** Zod parse errors in migration runner.

### Pitfall 6: Tarball Size Varies with node_modules
**What goes wrong:** Tarball verification fails intermittently because size threshold is too tight
**Why it happens:** `npm ci --production` can produce slightly different node_modules sizes across npm versions or platforms
**How to avoid:** Set a generous threshold (e.g., 15-20 MB). The check is a safety net against accidentally shipping node_modules or large binaries, not a precision measurement. Check the current tarball size to calibrate.
**Warning signs:** CI failures on clean builds with no code changes.

## Code Examples

Verified patterns from the existing codebase:

### Reading Version from package.json
```typescript
// Source: src/cli/commands/setup.ts:84
async function readPackageVersion(dataDir: string): Promise<string> {
  try {
    const content = await readFile(join(dataDir, "package.json"), "utf-8");
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
```

### Reading Migration History
```typescript
// Source: src/packaging/migrations.ts:124
export async function getMigrationHistory(aofRoot: string): Promise<MigrationHistory> {
  const historyPath = join(aofRoot, MIGRATION_HISTORY_FILE);
  try {
    await access(historyPath);
    const content = await readFile(historyPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { migrations: [] };
  }
}
```

### Schema Validation Pattern
```typescript
// Source: src/schemas/project.ts, src/schemas/org-chart.ts
import { ProjectManifest } from "../../schemas/project.js";
import { OrgChart } from "../../schemas/org-chart.js";

// Validate a project manifest
const yaml = await readFile(projectPath, "utf-8");
const parsed = parseYaml(yaml);
const result = ProjectManifest.safeParse(parsed);
// result.success: boolean, result.error: ZodError | undefined
```

### CLI Command Registration
```typescript
// Source: src/cli/commands/system.ts pattern
import type { Command } from "commander";

export function registerSmokeCommand(program: Command): void {
  program
    .command("smoke")
    .description("Run post-install health checks")
    .action(async () => {
      const root = program.opts()["root"] as string;
      // ... run checks against root
    });
}
```

### Temp Directory Test Pattern
```typescript
// Source: src/packaging/__tests__/migrations-impl.test.ts
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aof-upgrade-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
```

### Running Actual Migrations in Tests
```typescript
// Source: src/cli/commands/setup.ts:62, src/packaging/__tests__/migrations-impl.test.ts
import { runMigrations } from "../../packaging/migrations.js";
import { migration001 } from "../../packaging/migrations/001-default-workflow-template.js";
import { migration002 } from "../../packaging/migrations/002-gate-to-dag-batch.js";
import { migration003 } from "../../packaging/migrations/003-version-metadata.js";

function getAllMigrations(): Migration[] {
  return [migration001, migration002, migration003];
}

const result = await runMigrations({
  aofRoot: tmpDir,
  migrations: getAllMigrations(),
  targetVersion: "1.3.0",
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Gate-based task workflows | DAG-based task workflows | v1.2-v1.3 migration | Smoke tests must validate DAG format, upgrade tests must verify gate-to-DAG conversion |
| No version metadata | `.aof/channel.json` with version tracking | v1.3 (migration003) | Smoke tests check channel.json exists and contains valid version |
| Schema version locked to 1 | Schema version 1 or 2 | v1.3 (MIGR-05) | Fixtures must use correct schema version for their scenario |
| No defaultWorkflow field | `defaultWorkflow` in project.yaml | v1.3 (DAGD-01, migration001) | Smoke tests validate workflow templates are resolvable |

**Deprecated/outdated:**
- Gate-based workflows: Replaced by DAG workflows. Migration002 converts these. Pre-v1.2 fixtures should have gate fields; post-migration state should not.
- `.version` file: Legacy approach to version tracking. Replaced by `.aof/channel.json` in migration003.

## Open Questions

1. **Exact tarball size threshold**
   - What we know: Current tarball is unknown size; the threshold is purely a safety net against shipping large binaries
   - What's unclear: What is a reasonable threshold? Need to build a tarball to measure baseline.
   - Recommendation: Build a tarball during development, measure, set threshold at 2x that size (e.g., if baseline is 5MB, threshold is 10-15MB). This is Claude's discretion per CONTEXT.md.

2. **Should `readPackageVersion` be extracted to a shared module?**
   - What we know: It's currently a private function in `setup.ts`. Smoke checks need the same logic.
   - What's unclear: Whether to duplicate the 6-line function or refactor to share it.
   - Recommendation: Inline it in the smoke module (it's trivial). Avoid refactoring setup.ts in a verification phase -- minimize scope.

3. **Where to register `bd smoke` command**
   - What we know: System commands are in `system-commands.ts`, registered via `system.ts`. The smoke command is conceptually a "system" command.
   - What's unclear: Whether to add it to `system-commands.ts` or create a dedicated `smoke.ts`.
   - Recommendation: Create a dedicated `src/cli/commands/smoke.ts` with `registerSmokeCommand()`, then add it to `system.ts`. Follows the pattern of `setup.ts` which has its own file but is registered in `program.ts`. Smoke is significant enough to warrant its own file.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/cli/commands/setup.ts` -- runSetup flow, readPackageVersion, getAllMigrations
- Codebase analysis: `src/packaging/migrations.ts` -- runMigrations, getMigrationHistory, Migration interface
- Codebase analysis: `src/cli/commands/system-commands.ts` -- command registration pattern
- Codebase analysis: `src/cli/commands/system.ts` -- registerSystemCommands orchestrator
- Codebase analysis: `src/cli/program.ts` -- full command registration flow
- Codebase analysis: `src/schemas/project.ts` -- ProjectManifest schema with workflowTemplates, defaultWorkflow
- Codebase analysis: `src/schemas/org-chart.ts` -- OrgChart schema
- Codebase analysis: `src/schemas/config.ts` -- AofConfig schema
- Codebase analysis: `src/packaging/__tests__/migrations-impl.test.ts` -- fixture-based migration testing pattern
- Codebase analysis: `src/packaging/__tests__/migrations.test.ts` -- migration framework unit tests
- Codebase analysis: `scripts/build-tarball.mjs` -- tarball build script (verification script complement)
- Codebase analysis: `.release-it.json` -- release pipeline hooks
- Codebase analysis: `src/cli/commands/task-create-workflow.ts` -- resolveWorkflowTemplate, resolveDefaultWorkflow
- Codebase analysis: `src/daemon/health.ts` -- health check pattern (reference, different scope)
- Codebase analysis: `vitest.config.ts` -- test configuration

### Secondary (MEDIUM confidence)
- Package versions: vitest ^3.0.0, commander ^14.0.3 (from package.json)
- Project conventions: temp dir pattern, fixture pattern (from existing tests)

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in use, no new dependencies
- Architecture: HIGH -- all patterns directly derived from existing codebase code
- Pitfalls: HIGH -- derived from analyzing actual code paths and known edge cases

**Research date:** 2026-03-03
**Valid until:** 2026-04-03 (stable -- no external dependencies, all internal to project)
