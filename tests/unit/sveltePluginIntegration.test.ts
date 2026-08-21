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

const TEMPLATE_EVENT_CALLEE = "__eventra_svelte_template_event__";

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: {
    include: ["**/*.svelte"],
    exclude: ["node_modules", "dist", ".svelte-kit", ".git"],
  },
};

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "svelte-plugin-integration-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Mirrors @eventra_dev/cli-plugin-svelte's current external contract and
 * virtual module shape (a single merged `.svelte.ts`: script content, then a
 * function wrapping synthetic template-event calls — literal names quoted,
 * dynamic bindings passed through as a raw expression) without depending on
 * the package itself. Same rationale as `vuePluginIntegration.test.ts`:
 * `packages/cli` is `git subtree split` into its own standalone repo where
 * `packages/cli-plugin-svelte` does not exist as a sibling directory, so this
 * suite cannot import the real package's source — that exact parsing logic
 * is covered by `@eventra_dev/cli-plugin-svelte`'s own test suite instead.
 * This test only verifies the CLI-side wiring: adapter → preprocessor →
 * `EventraEngine` → sink/dynamic-occurrence pipeline.
 */
function svelteShapedPlugin(): ExternalCliPlugin {
  return {
    id: "svelte",
    includeGlobs: ["**/*.svelte"],
    staticSinks: [
      { id: "svelte-template-event", callee: TEMPLATE_EVENT_CALLEE, eventNameArgumentIndex: 0 },
    ],
    match: (p) => p.endsWith(".svelte"),
    transform: async ({ path: p, source }) => {
      const scriptMatch = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
      const script = scriptMatch?.[1]?.trim() ?? "";

      const calls: string[] = [];
      for (const m of source.matchAll(/\bevent\s*=\s*"([^"]+)"/gi)) {
        calls.push(`${TEMPLATE_EVENT_CALLEE}("${m[1]}");`);
      }
      for (const m of source.matchAll(/\bevent\s*=\s*\{([^}]+)\}/gi)) {
        calls.push(`${TEMPLATE_EVENT_CALLEE}(${m[1]});`);
      }

      const parts = [script || "export {}"];
      if (calls.length > 0) {
        parts.push(
          [
            `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`,
            "function __eventraSvelteTemplate() {",
            ...calls.map((c) => `  ${c}`),
            "}",
          ].join("\n"),
        );
      }

      return { modules: [{ path: p.replace(/\.svelte$/i, ".svelte.ts"), content: parts.join("\n\n") }] };
    },
  };
}

async function scanSvelteFile(root: string, fileName: string, source: string) {
  const registry = createBuiltinPluginRegistry();
  registerExternalCliPlugin(svelteShapedPlugin(), registry);

  const abs = path.join(root, fileName);
  fs.writeFileSync(abs, source);

  const virtualFiles = await registry.preprocessFile({ fileName: abs, content: source });
  expect(virtualFiles).toHaveLength(1);

  const engine = new EventraEngine(root, registry);
  engine.beginPreload();
  await engine.preloadFile("__eventra_sdk_types__.d.ts", EVENTRA_SDK_SHIM);
  for (const virtualFile of virtualFiles) {
    await engine.preloadFile(virtualFile.fileName, virtualFile.content);
  }
  engine.endPreload();

  await engine.runFullAnalysis(
    ["__eventra_sdk_types__.d.ts", ...virtualFiles.map((f) => f.fileName)],
    CONFIG,
  );
  return engine;
}

describe("svelte-shaped external plugin integration", () => {
  it("detects literal template events and real SDK track() calls from a .svelte file", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = await scanSvelteFile(
        root,
        "Checkout.svelte",
        `
          <script lang="ts">
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const tracker = new Eventra({ apiKey: "test" });
          tracker.track("checkout.started");
          </script>
          <button event="checkout.cta">Pay</button>
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
      const engine = await scanSvelteFile(
        root,
        "Dynamic.svelte",
        `<button event={computedName} />`,
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
      const engine = await scanSvelteFile(
        root,
        "ScopedDynamic.svelte",
        `
          <script>
          const eventName = "from_script_const";
          </script>
          <button event={eventName} />
        `,
      );

      expect(engine.getAllEvents()).toContain("from_script_const");
      expect(engine.getAllDynamicOccurrences()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
