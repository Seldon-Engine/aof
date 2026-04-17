# Phase 43 — Deferred Items (out-of-scope discoveries)

Items surfaced during 43-03 execution that are outside the plan's scope and
are documented here rather than fixed. Per executor SCOPE BOUNDARY rule,
unrelated pre-existing failures are not fixed by this plan.

## Pre-existing CLI test failures (baseline, unaffected by 43-03 through 43-07)

Confirmed present on the 43-03 base commit before any IPC changes were made
AND re-verified on the 43-07 base by `git stash && npx vitest run <path>`.
17 failures total, all in CLI subprocess tests unrelated to the `src/ipc/` /
`src/daemon/` / `src/openclaw/` surface.

- `src/commands/__tests__/memory-cli.test.ts` — 11 failing (all cases)
- `src/commands/__tests__/org-drift-cli.test.ts` — 6 failing (subset)

**Owner:** separate fix PR; unrelated to Phase 43 scope (daemon authority
inversion). These tests spawn the CLI as a subprocess and the failures
appear to be environmental (missing binary / stale build).

## Missing migration test file (43-07 baseline)

- `src/packaging/migrations/__tests__/007-daemon-required.test.ts` — test
  imports a module that does not yet exist; the migration file is slated for
  Plan 43-08. Vitest picks up the test file via glob but fails to load. Not a
  regression; the phase's migration wave hasn't landed yet.
