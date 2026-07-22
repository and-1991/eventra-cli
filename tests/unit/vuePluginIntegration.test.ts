import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import { registerExternalCliPlugin } from "../../src/plugin/adapters/external";
import type { ExternalCliPlugin } from "../../src/plugin/adapters/external";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";
const TEMPLATE_EVENT_CALLEE = "__eventra_vue_template_event__";

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

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-plugin-integration-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Mirrors @eventra_dev/cli-plugin-vue's current external contract and virtual
 * module shape (a single merged `.vue.ts`: script content, then a function
 * wrapping synthetic template-event calls — literal names quoted, dynamic
 * bindings passed through as a raw expression) without depending on the
 * package itself. `packages/cli` is `git subtree split` into its own
 * standalone repo (see `.github/workflows/sync_cli` upstream) where
 * `packages/cli-plugin-vue` does not exist as a sibling directory, so this
 * suite cannot import the real package's source — that exact parsing logic
 * is covered by `@eventra_dev/cli-plugin-vue`'s own test suite instead. This
 * test only verifies the CLI-side wiring: adapter → preprocessor →
 * `EventraEngine` → sink/dynamic-occurrence pipeline.
 */
function vueShapedPlugin(): ExternalCliPlugin {
  return {
    id: "vue",
    includeGlobs: ["**/*.vue"],
    staticSinks: [
      { id: "vue-template-event", callee: TEMPLATE_EVENT_CALLEE, eventNameArgumentIndex: 0 },
    ],
    match: (p) => p.endsWith(".vue"),
    transform: async ({ path: p, source }) => {
      const scriptMatch = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
      const script = scriptMatch?.[1]?.trim() ?? "";
      const templateMatch = source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
      const template = templateMatch?.[1] ?? "";

      const calls: string[] = [];
      for (const m of template.matchAll(/(?<![:\w])event\s*=\s*"([^"]+)"/gi)) {
        calls.push(`${TEMPLATE_EVENT_CALLEE}("${m[1]}");`);
      }
      for (const m of template.matchAll(/:event\s*=\s*"([^"]+)"/gi)) {
        calls.push(`${TEMPLATE_EVENT_CALLEE}(${m[1]});`);
      }

      const parts = [script || "export {}"];
      if (calls.length > 0) {
        parts.push(
          [
            `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`,
            "function __eventraVueTemplate() {",
            ...calls.map((c) => `  ${c}`),
            "}",
          ].join("\n"),
        );
      }

      return { modules: [{ path: p.replace(/\.vue$/i, ".vue.ts"), content: parts.join("\n\n") }] };
    },
  };
}

async function scanVueFile(root: string, fileName: string, source: string) {
  const registry = createBuiltinPluginRegistry();
  registerExternalCliPlugin(vueShapedPlugin(), registry);

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

describe("vue-shaped external plugin integration", () => {
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
      expect(occurrences[0]?.calleeText).toBe(TEMPLATE_EVENT_CALLEE);
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
});
