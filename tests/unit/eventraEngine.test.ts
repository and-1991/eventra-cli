import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: {
    include: ["**/*.{ts,tsx,js,jsx}"],
    exclude: ["node_modules", "dist", ".next", ".git"],
  },
};

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function preloadEngine(
  engine: EventraEngine,
  root: string,
  files: Record<string, string>,
): Promise<string[]> {
  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
  const fileNames: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    await engine.preloadFile(abs, content);
    fileNames.push(abs);
  }
  engine.endPreload();
  return [SDK_TYPES, ...fileNames];
}

describe("EventraEngine", () => {
  it("extracts direct track() calls from a single file", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("checkout.completed");
          sdk.track("app.loaded");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);

      expect(engine.getAllEvents().sort()).toEqual([
        "app.loaded",
        "checkout.completed",
      ]);
    } finally {
      cleanup();
    }
  });

  it("ignores track() calls from non-SDK modules", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          import { analytics } from "./fake-analytics";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("real.event");
          analytics.track("fake.event");
          // generic call
          (function track(name: string) {})("global.fake");
        `,
        "fake-analytics.ts": `
          export const analytics = {
            track(name: string) { /* noop */ },
          };
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      const events = engine.getAllEvents();
      expect(events).toContain("real.event");
      expect(events).not.toContain("fake.event");
      expect(events).not.toContain("global.fake");
    } finally {
      cleanup();
    }
  });

  it("resolves wrappers across files (cross-file propagation)", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function trackFeature(name: string) {
            sdk.track(name);
          }
        `,
        "app.ts": `
          import { trackFeature } from "./tracker";
          trackFeature("user.signup");
          trackFeature("user.logout");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents().sort()).toEqual([
        "user.logout",
        "user.signup",
      ]);
      expect(engine.getAllFunctionWrappers()).toContain("trackFeature");
    } finally {
      cleanup();
    }
  });

  it("updateFile() reflects changes in subsequent extractions", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("v1.event");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toEqual(["v1.event"]);

      const appPath = path.join(root, "app.ts");
      await engine.updateFile(
        appPath,
        `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("v2.event");
          sdk.track("extra.event");
        `,
        CONFIG,
      );

      expect(engine.getAllEvents().sort()).toEqual(["extra.event", "v2.event"]);
    } finally {
      cleanup();
    }
  });

  it("updateFile() on a wrapper file repropagates events in call sites", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function trackFeature(name: string) {
            sdk.track(name);
          }
        `,
        "app.ts": `
          import { trackFeature } from "./tracker";
          trackFeature("initial");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toEqual(["initial"]);

      const trackerPath = path.join(root, "tracker.ts");
      await engine.updateFile(
        trackerPath,
        `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          // add an internal call
          export function trackFeature(name: string) {
            sdk.track(name);
            sdk.track("internal.from.wrapper");
          }
        `,
        CONFIG,
      );

      const events = engine.getAllEvents();
      expect(events).toContain("initial");
      expect(events).toContain("internal.from.wrapper");
    } finally {
      cleanup();
    }
  });

  it("removeFile() drops events from the gone file and reanalyzes dependents", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function trackFeature(name: string) { sdk.track(name); }
        `,
        "app.ts": `
          import { trackFeature } from "./tracker";
          trackFeature("call.site.event");
        `,
        "standalone.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const local = new Eventra({ apiKey: "k" });
          local.track("standalone.event");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toContain("call.site.event");
      expect(engine.getAllEvents()).toContain("standalone.event");

      const standalonePath = path.join(root, "standalone.ts");
      await engine.removeFile(standalonePath, CONFIG);

      const after = engine.getAllEvents();
      expect(after).not.toContain("standalone.event");
      // call-site event must still be detected
      expect(after).toContain("call.site.event");
    } finally {
      cleanup();
    }
  });

  it("preloadFile throws when called outside a beginPreload()/endPreload() phase", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      await expect(engine.preloadFile(path.join(root, "a.ts"), "export const a = 1;")).rejects.toThrow(
        "preload phase not active",
      );
    } finally {
      cleanup();
    }
  });

  it("scanFile analyzes a single file directly, without runFullAnalysis", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("direct.scan.event");
        `,
      });
      const appFile = files[files.length - 1]!;

      const result = await engine.scanFile(appFile, CONFIG);
      expect(result.events).toEqual(new Set(["direct.scan.event"]));
      expect(engine.getAllEvents()).toEqual(["direct.scan.event"]);
    } finally {
      cleanup();
    }
  });

  it("indexFile and extractFile are no-ops (index deleted / EMPTY_RESULT) for a file outside the program", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const missing = path.join(root, "missing.ts");

      // Not staged/preloaded at all — compiler.getSourceFile() returns undefined.
      expect(() => engine.indexFile(missing, CONFIG)).not.toThrow();
      const result = engine.extractFile(missing, CONFIG);
      expect(result.events.size).toBe(0);
      expect(result.detectedFunctionWrappers.size).toBe(0);
      expect(result.dynamicOccurrences).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("getScanResult returns the stored result for a known file and an empty result for an unknown one", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("scoped.event");
        `,
      });
      const appFile = files[files.length - 1]!;

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getScanResult(appFile).events).toEqual(new Set(["scoped.event"]));

      const empty = engine.getScanResult(path.join(root, "never-scanned.ts"));
      expect(empty.events.size).toBe(0);
      expect(empty.detectedFunctionWrappers.size).toBe(0);
      expect(empty.dynamicOccurrences).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("getAllDynamicOccurrences aggregates across files and sorts by fileName then line", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "b.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          declare function dyn(): string;
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track(dyn());
        `,
        "a.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          declare function dyn(): string;
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("static.one");
          sdk.track(dyn());
          sdk.track(dyn());
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      const occurrences = engine.getAllDynamicOccurrences();
      expect(occurrences).toHaveLength(3);

      const fileNames = occurrences.map((o) => o.fileName);
      const sorted = [...fileNames].sort();
      expect(fileNames.filter((f) => f.endsWith("a.ts"))).toHaveLength(2);
      expect(fileNames.filter((f) => f.endsWith("b.ts"))).toHaveLength(1);
      // a.ts sorts before b.ts; within a.ts, the two occurrences must be
      // ordered by ascending line number.
      expect(fileNames).toEqual(sorted);
      const aOccurrences = occurrences.filter((o) => o.fileName.endsWith("a.ts"));
      expect(aOccurrences[0]!.line).toBeLessThan(aOccurrences[1]!.line);
    } finally {
      cleanup();
    }
  });

  it("updateImportGraph skips export-assignment statements and bare (no-specifier) exports", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "dep.ts": `
          export const dep = 1;
        `,
        // export-assignment (CommonJS-style "export =") — must be skipped by
        // updateImportGraph's isExportAssignment guard before the
        // import/export-declaration check even runs.
        "cjsStyle.ts": `
          const value = 1;
          export = value;
        `,
        "app.ts": `
          import { dep } from "./dep";
          const value = dep;
          export { value }; // bare export, no module specifier -> continue
        `,
      });
      const appFile = files.find((f) => f.endsWith("app.ts"))!;
      const cjsFile = files.find((f) => f.endsWith("cjsStyle.ts"))!;

      await engine.runFullAnalysis(files, CONFIG);
      // updateFile() re-runs the scheduler flush -> updateImportGraph() on
      // both files, walking the export-assignment and bare-export statements.
      await engine.updateFile(cjsFile, "const value = 2;\nexport = value;", CONFIG);
      await engine.updateFile(
        appFile,
        `
          import { dep } from "./dep";
          const value = dep + 1;
          export { value };
        `,
        CONFIG,
      );

      expect(engine.getAllEvents()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("removeFile() falls back to the last-used config when no config argument is passed", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "standalone.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const local = new Eventra({ apiKey: "k" });
          local.track("standalone.event");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toContain("standalone.event");

      const standalonePath = path.join(root, "standalone.ts");
      await engine.removeFile(standalonePath);

      expect(engine.getAllEvents()).not.toContain("standalone.event");
    } finally {
      cleanup();
    }
  });

  it("removeFile() reanalyzes dependent files via reanalyzeFiles when dependents exist", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function trackFeature(name: string) { sdk.track(name); }
        `,
        "app.ts": `
          import { trackFeature } from "./tracker";
          trackFeature("dependent.event");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toContain("dependent.event");

      // Delete tracker.ts from disk too (mirrors the real watch.ts trigger for
      // removeFile) — otherwise ts's own module resolution would just re-read
      // it back off disk as an unlisted dependency of app.ts and the wrapper
      // would keep resolving.
      fs.rmSync(path.join(root, "tracker.ts"));

      // Removing tracker.ts has a dependent (app.ts), so removeFile must take
      // the reanalyzeFiles() branch rather than the no-dependents fast path.
      await engine.removeFile(path.join(root, "tracker.ts"), CONFIG);

      // app.ts survives (still indexed), just no longer resolves the wrapper.
      expect(engine.getAllEvents()).not.toContain("dependent.event");
    } finally {
      cleanup();
    }
  });

  it("getAllFunctionWrappers filters out anonymous / internal names", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function publicWrapper(name: string) { sdk.track(name); }
        `,
        "app.ts": `
          import { publicWrapper } from "./tracker";
          publicWrapper("a");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      const wrappers = engine.getAllFunctionWrappers();
      expect(wrappers).toContain("publicWrapper");
      // sanity: no synthetic names
      expect(wrappers.every((w) => !w.startsWith("__"))).toBe(true);
      expect(wrappers.every((w) => w !== "anonymous")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("getAllFunctionWrappers actually drops an 'anonymous'/empty/'__'-prefixed name when one is present", async () => {
    // Provoking the analyzer into emitting an "anonymous"/"__"-prefixed wrapper
    // name from real source would depend on internals of analysis/** (treated
    // as a black box here). The aggregation/filter under test lives entirely
    // in EventraEngine itself, so this seeds fileResults directly — a
    // real Set<string>, run through the real filter — to exercise the
    // false side of each condition in that filter.
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const fileResults = (
        engine as unknown as {
          fileResults: Map<string, { detectedFunctionWrappers: Set<string>; events: Set<string>; dynamicOccurrences: unknown[] }>;
        }
      ).fileResults;
      fileResults.set(path.join(root, "fake.ts"), {
        events: new Set(),
        detectedFunctionWrappers: new Set(["anonymous", "__internal", "", "realWrapper"]),
        dynamicOccurrences: [],
      });

      expect(engine.getAllFunctionWrappers()).toEqual(["realWrapper"]);
    } finally {
      cleanup();
    }
  });

  it("updateImportGraph removes a file from the import graph when it's no longer in the program", async () => {
    // Reachable only in-process: the scheduler always calls this right after
    // compiler.updateFile() staged the same file, so it's guaranteed to be
    // present in the just-rebuilt program on every real call path. Calling
    // the private method directly against a file that was never staged
    // exercises the defensive fallback.
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const missing = path.join(root, "missing.ts");
      expect(() =>
        (engine as unknown as { updateImportGraph(fileName: string): void }).updateImportGraph(missing),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });
});
