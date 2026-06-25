import { describe, expect, it } from "vitest";

import { registerExternalCliPlugin } from "../../src/plugin/adapters/external";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import type { ExternalCliPlugin } from "../../src/plugin/adapters/external";

describe("registerExternalCliPlugin", () => {
  it("maps plugin transform output to internal virtual files", async () => {
    const registry = createBuiltinPluginRegistry();
    const plugin: ExternalCliPlugin = {
      id: "test-vue",
      includeGlobs: ["**/*.vue"],
      staticSinks: [
        {
          id: "test-template",
          callee: "__test_template_event__",
          eventNameArgumentIndex: 0,
        },
      ],
      match: (path) => path.endsWith(".vue"),
      transform: async ({ path }) => ({
        modules: [{ path: `${path}.ts`, content: 'sdk.track("from.vue");' }],
      }),
    };

    registerExternalCliPlugin(plugin, registry);

    const files = await registry.preprocessFile({
      fileName: "/app/Button.vue",
      content: "<script />",
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.fileName).toBe("/app/Button.vue.ts");
    expect(registry.getIncludePatterns()).toContain("**/*.vue");
    expect(registry.getSinkDetectors().map((d) => d.name)).toContain("test-template");
  });

  it("rejects invalid transform results", async () => {
    const registry = createBuiltinPluginRegistry();
    const plugin: ExternalCliPlugin = {
      id: "bad",
      includeGlobs: [],
      match: () => true,
      transform: async () => ({ modules: null as unknown as [] }),
    };

    registerExternalCliPlugin(plugin, registry);

    await expect(
      registry.preprocessFile({ fileName: "/x.ts", content: "" }),
    ).rejects.toThrow(/invalid transform result/);
  });
});
