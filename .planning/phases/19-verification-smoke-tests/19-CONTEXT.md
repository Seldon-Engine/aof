# Phase 19: Verification & Smoke Tests - Context

**Gathered:** 2026-03-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Automated validation of the v1.3 upgrade path: a `bd smoke` CLI command for post-install health checks, an upgrade scenario test suite covering four install paths, and a tarball verification script for pre-release validation. Covers requirements VERF-01, VERF-02, VERF-03.

</domain>

<decisions>
## Implementation Decisions

### bd smoke command (VERF-01)
- Standalone `bd smoke` subcommand — not part of daemon health (different scope: install verification vs runtime health)
- Checks: version string, schema validation, task store read, org chart read, migration status (from `.aof/migrations.json`), workflow templates validation
- Output: checklist format with pass/fail per check, exit code 0 if all pass, non-zero on any failure
- Must work without a running daemon — reads files directly

### Upgrade test suite (VERF-02)
- Vitest-based tests using fixture directories that simulate four scenarios
- Scenarios: fresh install (empty data dir), pre-v1.2 upgrade (gate-based tasks, no migrations), v1.2 upgrade (partial migrations), DAG-default (configured defaultWorkflow)
- Fixtures are static YAML files committed to the repo under test fixtures directory
- Tests exercise the actual migration runner and verify end-state

### Tarball verification (VERF-03)
- Standalone script (not vitest) — runs against a built tarball
- Validates: extraction succeeds, `npm ci --production` completes, CLI boots (`bd --version`), version string matches package.json, package size under threshold
- Designed to run in CI between build and upload steps

### Claude's Discretion
- Exact check order in bd smoke
- Fixture directory structure and naming
- Tarball size threshold
- Whether tarball verification is shell script or Node.js
- Error message formatting

</decisions>

<specifics>
## Specific Ideas

No specific requirements — the three success criteria from ROADMAP.md are precise enough.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `getHealthStatus()` in `src/daemon/health.ts`: Runtime health check pattern (different scope but similar structure)
- `readPackageVersion()` in `src/cli/commands/setup.ts:84`: Reads version from package.json — reusable for smoke checks
- `getMigrationHistory()` in `src/packaging/migrations.ts`: Reads `.aof/migrations.json` — reusable for migration status check
- `build-tarball.mjs` in `scripts/`: Existing tarball builder — verification script complements it
- `ProjectManifest` schema in `src/schemas/project.ts`: Schema validation for project files
- `ConfigSchema`, `TaskYAML`, `OrgChart` schemas: All available for smoke validation

### Established Patterns
- CLI commands registered in `src/cli/commands/` via Commander.js
- System commands in `system-commands.ts` handle channel, deps, install, update
- Test fixtures typically live alongside test files in `__tests__/` directories or `__fixtures__/`
- Scripts in `scripts/` directory for build/deploy tooling

### Integration Points
- New `bd smoke` command registers alongside existing system commands
- Tarball verification script lives in `scripts/` next to `build-tarball.mjs`
- Upgrade test suite runs as part of `vitest` — can be in `src/packaging/__tests__/` alongside existing migration tests
- `setup.ts` `runSetup()` is the entry point for install/upgrade flows that tests will exercise

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 19-verification-smoke-tests*
*Context gathered: 2026-03-04*
