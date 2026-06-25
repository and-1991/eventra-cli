import { describe, expect, it } from "vitest";

import type { ExternalCliPlugin } from "../../src/plugin/adapters/external";
import { registerExternalCliPlugin } from "../../src/plugin/adapters/external";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";

/** Minimal Vue-shaped plugin fixture — mirrors @eventra_dev/cli-plugin-vue contract without the package. */
function createVueShapedPluginFixture(): ExternalCliPlugin {
  return {
    id: "vue",
    version: "0.0.0-test",
    includeGlobs: ["**/*.vue"],
    staticSinks: [
      {
        id: "vue-template-event",
        callee: "__eventra_vue_template_event__",
        eventNameArgumentIndex: 0,
      },
    ],
    match: (path) => path.endsWith(".vue"),
    transform: async ({ path, source }) => {
      const scriptMatch = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
      const script = scriptMatch?.[1]?.trim() ?? "";
      const templateMatch = source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
      const template = templateMatch?.[1] ?? "";
      const eventMatch = template.match(/\bevent\s*=\s*"([^"]+)"/i);

      const modules: Array<{ path: string; content: string }> = [
        {
          path: path.replace(/\.vue$/i, ".vue.ts"),
          content: script || "export {}\n",
        },
      ];

      if (eventMatch?.[1]) {
        const name = eventMatch[1];
        modules.push({
          path: path.replace(/\.vue$/i, ".vue.template.ts"),
          content: [
            "declare function __eventra_vue_template_event__(name: string): void;",
            `__eventra_vue_template_event__("${name}");`,
            "",
          ].join("\n"),
        });
      }

      return { modules };
    },
  };
}

describe("vue-shaped external plugin", () => {
  it("adapts script + template virtual modules and template sink", async () => {
    const registry = createBuiltinPluginRegistry();
    registerExternalCliPlugin(createVueShapedPluginFixture(), registry);

    const files = await registry.preprocessFile({
      fileName: "/src/Card.vue",
      content: `
        <script setup lang="ts">
        import { Eventra } from "@eventra_dev/eventra-sdk";
        new Eventra({ apiKey: "k" }).track("card.view");
        </script>
        <template><div event="card.cta" /></template>
      `,
    });

    expect(files).toHaveLength(2);
    expect(files[0]?.fileName).toBe("/src/Card.vue.ts");
    expect(files[0]?.content).toContain("card.view");
    expect(files[1]?.fileName).toBe("/src/Card.vue.template.ts");
    expect(files[1]?.content).toContain('__eventra_vue_template_event__("card.cta")');
    expect(registry.getSinkDetectors().map((d) => d.name)).toContain("vue-template-event");
    expect(registry.getIncludePatterns()).toContain("**/*.vue");
  });
});
