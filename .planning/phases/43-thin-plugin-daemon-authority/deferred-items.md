# Phase 43 — Deferred Items (out-of-scope discoveries)

Items surfaced during 43-03 execution that are outside the plan's scope and
are documented here rather than fixed. Per executor SCOPE BOUNDARY rule,
unrelated pre-existing failures are not fixed by this plan.

## Pre-existing CLI test failures (baseline, unaffected by 43-03)

Confirmed present on the 43-03 base commit before any IPC changes were made
(verified by `git stash && npx vitest run <path>`). 17 failures total, all
in CLI subprocess tests unrelated to the `src/ipc/` / `src/daemon/` surface.

- `src/commands/__tests__/memory-cli.test.ts` — 11 failing (all cases)
- `src/commands/__tests__/org-drift-cli.test.ts` — 6 failing (subset)

**Owner:** separate fix PR; unrelated to Phase 43 scope (daemon authority
inversion). These tests spawn the CLI as a subprocess and the failures
appear to be environmental (missing binary / stale build).
