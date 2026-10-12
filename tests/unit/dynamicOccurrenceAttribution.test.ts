import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import { registerExternalCliPlugin } from "../../src/plugin/adapters/external";
import type { ExternalCliPlugin } from "../../src/plugin/adapters/external";
import type { DynamicOccurrence } from "../../src/analysis/shared/dynamicOccurrence";

// Like the other *PluginIntegration tests: packages/cli is split into its own
// repo, so the real plugins cannot be imported. These fakes follow the same
// contract: a generated module whose script keeps its ORIGINAL line numbers
// (padded with blank lines) plus a generated function of template calls.
const VUE_CALLEE = "__eventra_vue_template_event__";
const NG_CALLEE = "__eventra_angular_template_event__";

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: { include: ["**/*"], exclude: ["node_modules"] },
};

const vueShaped: ExternalCliPlugin = {
  id: "vue",
  includeGlobs: ["**/*.vue"],
  staticSinks: [{ id: "vue-template-event", callee: VUE_CALLEE, eventNameArgumentIndex: 0 }],
  match: (p) => p.endsWith(".vue"),
  transform: async ({ path: p, source }) => {
    const open = source.indexOf("<script");
    const contentStart = source.indexOf(">", open) + 1;
    const content = source.slice(contentStart, source.indexOf("</script>", contentStart)).trim();
    const line = source.slice(0, source.indexOf(content)).split("\n").length;
    const dynamic = [...source.matchAll(/:event="([^"]+)"/g)].map((m) => `  ${VUE_CALLEE}(${m[1]});`);
    const module = [
      "\n".repeat(line - 1) + content,
      [`declare function ${VUE_CALLEE}(name: string): void;`, "function __t() {", ...dynamic, "}"].join("\n"),
    ].join("\n\n");
    return { modules: [{ path: p.replace(/\.vue$/, ".vue.ts"), content: module }] };
  },
};

const angularShaped: ExternalCliPlugin = {
  id: "angular",
  includeGlobs: ["**/*.html"],
  staticSinks: [{ id: "angular-template-event", callee: NG_CALLEE, eventNameArgumentIndex: 0 }],
  match: (p) => p.endsWith(".html"),
  transform: async ({ path: p }) => ({
    modules: [
      {
        path: `${p}.ts`,
        content: [
          `declare function ${NG_CALLEE}(name: string): void;`,
          `import { Eventra } from "@eventra_dev/eventra-sdk";`,
          "export class C {",
          "  name = 'x';",
          "  sdk = new Eventra({ apiKey: 'k' });",
          "  go(n: string) { this.sdk.track(n); }",
          `  __t() { ${NG_CALLEE}(this.name); ${NG_CALLEE}(this.name + Math.random()); }`,
          "}",
        ].join("\n"),
      },
    ],
  }),
};

const VUE_SOURCE = `<template>
  <button :event="pick">Pay</button>
</template>

<script setup lang="ts">
import { Eventra } from "@eventra_dev/eventra-sdk";
const sdk = new Eventra({ apiKey: "k" });
function go(name: string) { sdk.track(name); }
</script>
`;

const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
});

async function report(root: string, files: Record<string, string>, plugins: ExternalCliPlugin[]) {
  const registry = createBuiltinPluginRegistry();
  for (const plugin of plugins) registerExternalCliPlugin(plugin, registry);

  const engine = new EventraEngine(root, registry);
  engine.beginPreload();
  await engine.preloadFile("__eventra_sdk_types__.d.ts", EVENTRA_SDK_SHIM);
  const names = ["__eventra_sdk_types__.d.ts"];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    for (const virtual of await registry.preprocessFile({ fileName: abs, content })) {
      await engine.preloadFile(virtual.fileName, virtual.content);
      names.push(virtual.fileName);
    }
  }
  engine.endPreload();
  await engine.runFullAnalysis(names, CONFIG);

  process.chdir(root);
  const seen: DynamicOccurrence[] = [];
  registry.registerDynamicEventReporter({ name: "capture", report: ({ occurrences }) => void seen.push(...occurrences) });
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((text: unknown) => void lines.push(String(text)));
  await registry.runDynamicEventReporters(engine.getAllDynamicOccurrences());
  return { seen, printed: lines.filter((l) => l.startsWith("~")) };
}

describe("dynamic occurrence output for framework files", () => {
  it("prints the real file, relative to cwd, with the line the user wrote, and describes template events", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-attr-"));
    try {
      const { printed, seen } = await report(
        root,
        {
          "src/A.vue": VUE_SOURCE,
          // a plain file next to a framework file keeps its own path
          "lib/plain.ts": `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst s = new Eventra({ apiKey: "k" });\nexport const f = (n: string) => s.track(n);\n`,
        },
        [vueShaped],
      );

      const scriptLine = VUE_SOURCE.split("\n").findIndex((l) => l.includes("sdk.track(name)")) + 1;
      expect(printed).toContain(`~ src/A.vue:${scriptLine} sdk.track(...)`);
      expect(printed).toContain('~ template of src/A.vue: event="pick"');
      expect(printed.join("\n")).not.toContain("__eventra_");
      expect(printed.join("\n")).not.toContain(".vue.ts");
      expect(printed).toContain("~ lib/plain.ts:3 s.track(...)");
      expect(seen.filter((o) => o.fileName.endsWith("A.vue"))).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips Angular's implicit `this.` and does not report the embedded component class copy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-attr-ng-"));
    try {
      const { printed } = await report(root, { "x/c.component.html": "<p></p>" }, [angularShaped]);

      expect(printed).toContain('~ template of x/c.component.html: event="name + Math.random()"');
      // the embedded copy of the component class repeats a call the class file already reports
      expect(printed.some((line: string) => line.includes("component class"))).toBe(false);
      expect(printed.filter((line: string) => line.includes("this.sdk.track"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves plain TypeScript files alone and prints them relative to cwd too", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-attr-ts-"));
    try {
      const { printed, seen } = await report(
        root,
        { "lib/a.ts": `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst s = new Eventra({ apiKey: "k" });\nexport const f = (n: string) => s.track(n);\n` },
        [],
      );

      expect(printed).toEqual(["~ lib/a.ts:3 s.track(...)"]);
      expect(seen[0]?.inTemplate).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an absolute path for files outside the working directory", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-attr-cwd-"));
    try {
      process.chdir(elsewhere);
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((text: unknown) => void lines.push(String(text)));
      const outside = path.join(os.tmpdir(), "not-under-cwd", "a.ts");
      await createBuiltinPluginRegistry().runDynamicEventReporters([
        { fileName: outside, line: 3, character: 0, calleeText: "s.track", callText: "s.track(n)", resolvedValues: ["a"] },
      ]);

      expect(lines.filter((l) => l.startsWith("~"))).toEqual([`~ ${outside.replace(/\\/g, "/")}:3 s.track(...) (resolved: a)`]);
    } finally {
      process.chdir(cwd);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("dynamic occurrence attribution edge cases", () => {
  const occurrence = (fileName: string, callText: string, calleeText = VUE_CALLEE): DynamicOccurrence => ({
    fileName,
    line: 99,
    character: 0,
    calleeText,
    callText,
    resolvedValues: [],
  });

  async function printedFor(registryFiles: string[], occurrences: DynamicOccurrence[]): Promise<string[]> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-attr-edge-"));
    try {
      process.chdir(root);
      const registry = createBuiltinPluginRegistry();
      registerExternalCliPlugin(vueShaped, registry);
      for (const rel of registryFiles) {
        const abs = path.join(root, rel);
        await registry.preprocessFile({ fileName: abs, content: "<script>\n</script>\n" });
      }
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((text: unknown) => void lines.push(String(text)));
      await registry.runDynamicEventReporters(
        occurrences.map((o) => ({ ...o, fileName: path.join(root, o.fileName) })),
      );
      return lines.filter((l) => l.startsWith("~"));
    } finally {
      process.chdir(cwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("shows a cut-off template expression as is (callText is truncated at 120 characters)", async () => {
    const long = "x".repeat(120);
    const printed = await printedFor(["A.vue"], [occurrence("A.vue.ts", `${VUE_CALLEE}(${long}\u2026`)]);

    expect(printed).toEqual([`~ template of A.vue: event="${long}\u2026"`]);
  });

  it("falls back to the whole call text when it has no parentheses", async () => {
    const printed = await printedFor(["A.vue"], [occurrence("A.vue.ts", "weird")]);

    expect(printed).toEqual(['~ template of A.vue: event="weird"']);
  });

  it("does not remap a file that a plugin produced under its own name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-attr-same-"));
    try {
      process.chdir(root);
      const registry = createBuiltinPluginRegistry();
      registerExternalCliPlugin(
        {
          id: "same",
          includeGlobs: ["**/*.same"],
          match: (p) => p.endsWith(".same"),
          transform: async ({ path: p }) => ({ modules: [{ path: p, content: "export {}" }] }),
        },
        registry,
      );
      const abs = path.join(root, "a.same");
      await registry.preprocessFile({ fileName: abs, content: "" });
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((text: unknown) => void lines.push(String(text)));
      await registry.runDynamicEventReporters([{ ...occurrence(abs, "s.track(n)", "s.track") }]);

      expect(lines.filter((l) => l.startsWith("~"))).toEqual(["~ a.same:99 s.track(...)"]);
    } finally {
      process.chdir(cwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints an empty expression when a template occurrence carries none", async () => {
    const printed = await printedFor([], [{ ...occurrence("B.vue", "x"), inTemplate: true }]);

    expect(printed).toEqual(['~ template of B.vue: event=""']);
  });
});

