import { defineConfig } from "vitest/config";

/**
 * Default vitest config — the "fast unit suite" invoked by `npm test`.
 *
 * Scope discipline (2026-04-18 flake investigation, see
 * `.planning/debug/resolved/2026-04-18-vitest-flakes.md`):
 *   - Unit tests live under `src/** /__tests__/** /*.test.ts` and run in the
 *     default parallel forks pool with a 10s per-test timeout.
 *   - E2E tests (`tests/e2e/suites/**`) and integration tests
 *     (`tests/integration/**`) are DELIBERATELY EXCLUDED from this config.
 *     They have their own configs (`tests/vitest.e2e.config.ts`,
 *     `tests/integration/vitest.config.ts`) that set `pool: "forks"` +
 *     `singleFork: true` + 60s timeouts. Running them under this default pool
 *     (parallel workers, 10s timeout) causes nondeterministic failures:
 *     hook timeouts, ENOTEMPTY races on shared `~/.openclaw-aof-e2e-test/*`
 *     subtrees, and filesystem watcher event loss under IO load.
 *   - Invoke them explicitly: `npm run test:e2e`, `npm run test:integration:plugin`.
 */
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/e2e/**",
      "tests/integration/**",
      ".claude/worktrees/**",
    ],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "src/**/*.ts",
      ],
      exclude: [
        "src/**/__tests__/**",
        "src/testing/**",
        "src/schemas/**",
        "src/**/index.ts",
        "src/types/**",
      ],
    },
  },
});
