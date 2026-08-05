import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      // resolverTestUtils.ts is fixture/test-support code (its `throw new
      // Error` guards only fire when a *test* is written wrong), not product
      // code - it shouldn't be held to the same coverage bar as src/.
      exclude: ["tests/unit/resolverTestUtils.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
