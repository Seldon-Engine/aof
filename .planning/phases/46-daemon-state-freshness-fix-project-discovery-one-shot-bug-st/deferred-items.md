# Deferred items (out of scope for plan 46-06)

## CLI tests fail without `dist/` (pre-existing)

`src/commands/__tests__/memory-cli.test.ts` (11 cases) and
`src/commands/__tests__/org-drift-cli.test.ts` (6 cases) `spawnSync`
the built `dist/cli/index.js` and assert on `.status === 0`. In a
fresh worktree without a prior `npm run build`, these tests fail
with non-zero exit codes (the binary doesn't exist).

This is **not** caused by plan 46-06 changes (which touch
`src/ipc/routes/invoke-tool.ts` and `src/openclaw/dispatch-notification.ts`
only). All 60 IPC tests + all 83 openclaw tests pass with the new code.

Recommendation for future plans: either gate these CLI-subprocess tests
on a `beforeAll` build step, or move them to the integration suite that
already builds.
