import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

// Stryker's vitest runner forces pool: "threads", where process.chdir() is
// unsupported. These test files need chdir (directly or via the differential
// harness) and exercise code that is not in the mutate list, so skip them.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        "**/node_modules/**",
        "tests/unit/send.test.ts",
        "tests/unit/incrementalRebuild.test.ts",
        "tests/unit/dynamicOccurrenceAttribution.test.ts",
        "tests/unit/engineBatchFlush.test.ts",
        "tests/unit/documentRegistry.test.ts",
        "tests/unit/config.test.ts",
        "tests/unit/scanResults.test.ts",
      ],
    },
  }),
);
