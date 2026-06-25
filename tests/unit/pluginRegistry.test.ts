import { describe, expect, it } from "vitest";

import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import type { FilePreprocessor } from "../../src/plugin/types";

describe("PluginRegistry", () => {
  it("registers built-in eventra-sdk sink detector", () => {
    const registry = createBuiltinPluginRegistry();
    expect(registry.getSinkDetectors().map((d) => d.name)).toContain("eventra-sdk");
  });

  it("runs file preprocessors before default passthrough", async () => {
    const registry = createBuiltinPluginRegistry();
    const preprocessor: FilePreprocessor = {
      name: "test-vue",
      test: (fileName) => fileName.endsWith(".vue"),
      process: async ({ fileName }) => [
        {
          fileName: `${fileName}.virtual.ts`,
          content: `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk = new Eventra({ apiKey: "k" });
            sdk.track("from.vue");
          `,
        },
      ],
    };
    registry.registerFilePreprocessor(preprocessor);
    registry.registerIncludePattern("**/*.vue");

    const files = await registry.preprocessFile({
      fileName: "/app/Button.vue",
      content: "<script />",
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.fileName).toContain(".vue.virtual.ts");
    expect(registry.getIncludePatterns()).toContain("**/*.vue");
  });

  it("tracks virtual paths for a preprocessed source file", async () => {
    const registry = createBuiltinPluginRegistry();
    registry.registerFilePreprocessor({
      name: "vue",
      test: (fileName) => fileName.endsWith(".vue"),
      process: async ({ fileName }) => [
        { fileName: `${fileName}.ts`, content: "export {}" },
        { fileName: `${fileName}.template.ts`, content: "export {}" },
      ],
    });

    await registry.preprocessFile({
      fileName: "/app/Button.vue",
      content: "<script />",
    });

    expect(registry.getVirtualPathsForSource("/app/Button.vue")).toEqual([
      "/app/Button.vue.ts",
      "/app/Button.vue.template.ts",
    ]);
  });

  it("deduplicates include patterns", () => {
    const registry = createBuiltinPluginRegistry();
    registry.registerIncludePattern("**/*.vue");
    registry.registerIncludePattern("**/*.vue");
    expect(registry.getIncludePatterns()).toEqual(["**/*.vue"]);
  });
});
