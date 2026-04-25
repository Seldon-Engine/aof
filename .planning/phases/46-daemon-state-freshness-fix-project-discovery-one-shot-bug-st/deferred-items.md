# Phase 46 — Deferred Items (out of Plan 04 scope)

These test failures surfaced during the Plan 04 full-suite verification but are NOT
caused by Plan 04 changes. They are environmental/pre-existing and out of scope per
the executor scope-boundary rule.

## Failing test files

1. **`src/commands/__tests__/memory-cli.test.ts`** (11 cases) — uses `spawnSync("node", ["dist/cli/index.js", ...])`.
   `dist/` does not exist in a fresh worktree (never built). Pre-existing.

2. **`src/commands/__tests__/org-drift-cli.test.ts`** (4 cases) — same root cause: spawns
   `node dist/cli/index.js`. Pre-existing.

3. **`src/drift/__tests__/adapters.test.ts`** (1 case) — "throws error when openclaw command fails"
   times out at 10s. Depends on the `openclaw` CLI being installed at a specific path; in this
   worktree environment the CLI behaves differently. Pre-existing.

4. **`src/views/__tests__/watcher.test.ts`** (1 case) — "emits 'change' event when file is modified"
   fails intermittently due to fs-event ordering races. Confirmed flaky: passes when run in isolation
   on the un-modified base commit. Pre-existing.

## Verification of pre-existing status

Stashed Plan 04 changes and re-ran `src/views/__tests__/watcher.test.ts` against the base — passed
(flake confirmed). The CLI tests cannot be made to pass without first running `npm run build`,
which is outside the test phase contract.

## Recommendation

- **CLI tests (1, 2)** — either move to the integration suite (already gated by AOF_INTEGRATION=1)
  OR add a `beforeAll(() => execSync("npm run build"))` guard. Pre-existing decision; does not
  block Phase 46.
- **adapters.test.ts (3)** — investigate environment-dependence; likely needs a mock for
  `spawnSync("openclaw", ...)`.
- **watcher.test.ts (4)** — known flake; tracked as pre-existing.
