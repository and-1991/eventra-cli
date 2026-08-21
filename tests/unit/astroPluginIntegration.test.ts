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

const TEMPLATE_EVENT_CALLEE = "__eventra_astro_template_event__";

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: {
    include: ["**/*.astro"],
    exclude: ["node_modules", "dist", ".astro", ".git"],
  },
};

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astro-plugin-integration-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Mirrors @eventra_dev/cli-plugin-astro's current external contract and
 * virtual module shape (a single merged `.astro.ts`: frontmatter content,
 * then a function wrapping synthetic template-event calls — literal names
 * quoted, dynamic bindings passed through as a raw expression) without
 * depending on the package itself. Same rationale as
 * `vuePluginIntegration.test.ts`: `packages/cli` is `git subtree split` into
 * its own standalone repo where `packages/cli-plugin-astro` does not exist as
 * a sibling directory, so this suite cannot import the real package's
 * source — that exact parsing logic is covered by
 * `@eventra_dev/cli-plugin-astro`'s own test suite instead. This test only
 * verifies the CLI-side wiring: adapter → preprocessor → `EventraEngine` →
 * sink/dynamic-occurrence pipeline.
 */
function astroShapedPlugin(): ExternalCliPlugin {
  return {
    id: "astro",
    includeGlobs: ["**/*.astro"],
    staticSinks: [
      { id: "astro-template-event", callee: TEMPLATE_EVENT_CALLEE, eventNameArgumentIndex: 0 },
    ],
    match: (p) => p.endsWith(".astro"),
    transform: async ({ path: p, source }) => {
      const frontmatterMatch = source.match(/^---\n([\s\S]*?)\n?---/);
      const script = frontmatterMatch?.[1]?.trim() ?? "";
      const template = frontmatterMatch ? source.slice(frontmatterMatch[0].length) : source;

      const calls: string[] = [];
      for (const m of template.matchAll(/\bevent\s*=\s*"([^"]+)"/gi)) {
        calls.push(`${TEMPLATE_EVENT_CALLEE}("${m[1]}");`);
      }
      for (const m of template.matchAll(/\bevent\s*=\s*\{([^}]+)\}/gi)) {
        calls.push(`${TEMPLATE_EVENT_CALLEE}(${m[1]});`);
      }

      const parts = [script || "export {}"];
      if (calls.length > 0) {
        parts.push(
          [
            `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`,
            "function __eventraAstroTemplate() {",
            ...calls.map((c) => `  ${c}`),
            "}",
          ].join("\n"),
        );
      }

      return { modules: [{ path: p.replace(/\.astro$/i, ".astro.ts"), content: parts.join("\n\n") }] };
    },
  };
}

async function scanAstroFile(root: string, fileName: string, source: string) {
  const registry = createBuiltinPluginRegistry();
  registerExternalCliPlugin(astroShapedPlugin(), registry);

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

describe("astro-shaped external plugin integration", () => {
  it("detects literal template events and real SDK track() calls from a .astro file", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = await scanAstroFile(
        root,
        "Checkout.astro",
        `---
import { Eventra } from "@eventra_dev/eventra-sdk";
const tracker = new Eventra({ apiKey: "test" });
tracker.track("checkout.started");
---
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
      const engine = await scanAstroFile(root, "Dynamic.astro", `<button event={computedName} />`);

      const occurrences = engine.getAllDynamicOccurrences();
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.calleeText).toBe(TEMPLATE_EVENT_CALLEE);
    } finally {
      cleanup();
    }
  });

  it("resolves a dynamic template binding that references a real frontmatter const", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = await scanAstroFile(
        root,
        "ScopedDynamic.astro",
        `---
const eventName = "from_frontmatter_const";
---
<button event={eventName} />
`,
      );

      expect(engine.getAllEvents()).toContain("from_frontmatter_const");
      expect(engine.getAllDynamicOccurrences()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
