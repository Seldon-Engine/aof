import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
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
