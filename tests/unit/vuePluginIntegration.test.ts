import { describe, expect, it } from "vitest";

import { createCliPluginVue } from "@eventra_dev/cli-plugin-vue";
import { registerExternalCliPlugin } from "../../src/plugin/adapters/external";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";

describe("cli-plugin-vue integration", () => {
  it("adapts @eventra_dev/cli-plugin-vue into the registry", async () => {
    const registry = createBuiltinPluginRegistry();
    registerExternalCliPlugin(createCliPluginVue(), registry);

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
  });
});
