/**
 * Vitest configuration for E2E tests.
 * 
 * E2E tests run against a real OpenClaw gateway instance and test
 * the full AOF plugin integration.
 */

import { defineConfig } from "vitest/config";

// CI environment gets longer timeouts (2x)
const isCI = process.env.CI === "true";
const timeoutMultiplier = isCI ? 2 : 1;

export default defineConfig({
  test: {
    include: ["tests/e2e/suites/**/*.test.ts"],
    testTimeout: 60_000 * timeoutMultiplier, // E2E tests can be slower (2x in CI)
    hookTimeout: 30_000 * timeoutMultiplier, // Allow time for gateway startup (2x in CI)
    // Run E2E tests sequentially (not in parallel)
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Bail on first failure for faster feedback
    bail: 1,
  },
});
