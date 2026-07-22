import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import { registerExternalCliPlugin } from "../../src/plugin/adapters/external";
import { createCliPluginVue } from "../../../cli-plugin-vue/src/index";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: {
    include: ["**/*.vue"],
    exclude: ["node_modules", "dist", ".next", ".git"],
  },
};

const APP_VUE_FIXTURE = path.join(__dirname, "..", "fixtures", "frontend", "vue", "App.vue");

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-plugin-integration-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Runs the real `@eventra_dev/cli-plugin-vue` plugin (not a mock) through the
 * same preprocess → preload → analyze pipeline `scanProject` uses, against a
 * `.vue` file written to disk. The SDK type shim is preloaded so `.track()`
 * calls on a real `Eventra` instance resolve through the built-in sink
 * detector, exactly as they would in a real project.
 */
async function scanVueFile(root: string, fileName: string, source: string) {
  const registry = createBuiltinPluginRegistry();
  registerExternalCliPlugin(createCliPluginVue(), registry);

  const abs = path.join(root, fileName);
  fs.writeFileSync(abs, source);

  const virtualFiles = await registry.preprocessFile({ fileName: abs, content: source });
  expect(virtualFiles).toHaveLength(1);

  const engine = new EventraEngine(root, registry);
  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
  for (const virtualFile of virtualFiles) {
    await engine.preloadFile(virtualFile.fileName, virtualFile.content);
  }
  engine.endPreload();

  await engine.runFullAnalysis([SDK_TYPES, ...virtualFiles.map((f) => f.fileName)], CONFIG);
  return engine;
}

describe("cli-plugin-vue integration", () => {
  it("detects literal template events and real SDK track() calls from a .vue file", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = await scanVueFile(
        root,
        "Checkout.vue",
        `
          <script setup lang="ts">
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const tracker = new Eventra({ apiKey: "test" });
          tracker.track("checkout.started");
          </script>
          <template>
            <button event="checkout.cta" />
          </template>
        `,
      );

      const events = engine.getAllEvents();
      expect(events).toContain("checkout.started");
      expect(events).toContain("checkout.cta");
    } finally {
      cleanup();
    }
  });

  it("reports a dynamic template binding as a dynamic occurrence instead of dropping it", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = await scanVueFile(
        root,
        "Dynamic.vue",
        `
          <template>
            <button :event="computedName" />
          </template>
        `,
      );

      const occurrences = engine.getAllDynamicOccurrences();
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.calleeText).toBe("__eventra_vue_template_event__");
    } finally {
      cleanup();
    }
  });

  it("resolves a dynamic template binding that references a real script-level const", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = await scanVueFile(
        root,
        "ScopedDynamic.vue",
        `
          <script setup lang="ts">
          const eventName = "from_setup_const";
          </script>
          <template>
            <button :event="eventName" />
          </template>
        `,
      );

      expect(engine.getAllEvents()).toContain("from_setup_const");
      expect(engine.getAllDynamicOccurrences()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("scans the full App.vue fixture's template bindings end to end (literal + dynamic)", async () => {
    const { root, cleanup } = makeProject();
    try {
      const source = fs.readFileSync(APP_VUE_FIXTURE, "utf8");
      const engine = await scanVueFile(root, "App.vue", source);

      const events = engine.getAllEvents();
      // Literal `event="..."` attributes (name-based sink, unaffected by the
      // script body's lack of a real SDK import).
      expect(events).toContain("vue_button");
      expect(events).toContain("nested_button");
      expect(events).toContain("conditional_button");
      expect(events).toContain("array_1");
      expect(events).toContain("array_2");
      // Dynamic `:event="..."` bindings.
      expect(events).toContain("computed_button_event");
      expect(events).toContain("ternary_a_button");
      expect(events).toContain("ternary_b_button");

      const calleeTexts = engine.getAllDynamicOccurrences().map((o) => o.calleeText);
      expect(calleeTexts.filter((c) => c === "__eventra_vue_template_event__")).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
