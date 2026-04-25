# Phase 46 Deferred Items

Out-of-scope discoveries logged during plan execution. Per CLAUDE.md
"scope boundary" rule: only auto-fix issues directly caused by current
task changes. These pre-existing problems are noted here for future
work but NOT addressed in Phase 46.

## Pre-existing CLI subprocess test failures

**Discovered during:** Plan 46-05 verification run on worktree base
`989e79f` (2026-04-25T16:04Z).

**Symptom:** `./scripts/test-lock.sh run src/commands/__tests__/memory-cli.test.ts src/commands/__tests__/org-drift-cli.test.ts` produces 17 failures across 2 files. Pre-existing — confirmed reproducible on the branch base before Plan 46-05 changes via `git stash` test.

**Affected files:**
- `src/commands/__tests__/memory-cli.test.ts` (11 failures)
- `src/commands/__tests__/org-drift-cli.test.ts` (6 failures)

**Root cause (suspected):** Both files call `execSync` against the compiled CLI under `dist/cli/index.js`, which is not present in a fresh worktree (`npm run build` not run). The tests assume a built CLI binary; the dev/test loop has not historically required a build.

**Resolution path:** Either (a) make these tests build the CLI on demand in `beforeAll`, (b) wire them up to use `tsx` to run the source CLI directly, or (c) gate them behind `AOF_CLI_BUILT=1` like the integration tests gate on `AOF_INTEGRATION=1`. Track separately — out of scope for the Phase 46 daemon-state work.
