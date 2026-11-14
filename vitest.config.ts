import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    globals: false,
    setupFiles: ["tests/unit/setup-config-dir.ts"],
    // Most tests build a real TypeScript program; the 5s default is not
    // enough on a loaded or small CI runner and fails the suite at random.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      // resolverTestUtils.ts is fixture/test-support code (its `throw new
      // Error` guards only fire when a *test* is written wrong), not product
      // code - it shouldn't be held to the same coverage bar as src/.
      exclude: ["tests/unit/resolverTestUtils.ts", "tests/unit/setup-config-dir.ts", "tests/differential/**"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
