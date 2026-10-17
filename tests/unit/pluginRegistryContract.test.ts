import { describe, expect, it } from "vitest";

import { PluginRegistry } from "../../src/plugin/registry";
import type { FilePreprocessor, SinkDetector, SinkDetectorContext } from "../../src/plugin/types";
import type { DynamicOccurrence } from "../../src/analysis/shared/dynamicOccurrence";

// Direct, cwd-independent tests of PluginRegistry (absolute posix paths only, no process.chdir),
// written to pin the exact behaviour: names, messages, boundaries and which fields get set.

const VUE_CALLEE = "__eventra_vue_template_event__";
const NG_CALLEE = "__eventra_angular_template_event__";
const REGION_START = "// --- vue template (auto-generated) ---";
const REGION_END = "// --- end template ---";

function occurrence(overrides: Partial<DynamicOccurrence> = {}): DynamicOccurrence {
  return {
    fileName: "/proj/App.vue.ts",
    line: 3,
    character: 7,
    calleeText: VUE_CALLEE,
    callText: `${VUE_CALLEE}(name)`,
    resolvedValues: ["a", "b"],
    ...overrides,
  };
}

/** A registry where `source` was preprocessed into the given virtual modules. */
async function registryWith(source: string, modules: Record<string, string>): Promise<PluginRegistry> {
  const registry = new PluginRegistry();
  registry.registerFilePreprocessor({
    name: "fake",
    test: (fileName) => fileName === source,
    process: async () => Object.entries(modules).map(([fileName, content]) => ({ fileName, content })),
  });
  await registry.preprocessFile({ fileName: source, content: "" });
  return registry;
}

async function attribute(registry: PluginRegistry, ...occurrences: DynamicOccurrence[]): Promise<readonly DynamicOccurrence[]> {
  let seen: readonly DynamicOccurrence[] = [];
  registry.registerDynamicEventReporter({
    name: "capture",
    report: ({ occurrences: attributed }) => {
      seen = attributed;
    },
  });
  await registry.runDynamicEventReporters(occurrences);
  return seen;
}

const noopSink = (name: string, result: ReturnType<SinkDetector["detect"]>): SinkDetector => ({ name, detect: () => result });

describe("PluginRegistry registration", () => {
  it("rejects a duplicate name with the exact message for each plugin kind", () => {
    const registry = new PluginRegistry();
    registry.registerFilePreprocessor({ name: "p", test: () => false, process: async () => [] });
    registry.registerSinkDetector(noopSink("s", null));
    registry.registerWrapperDetector({ name: "w", detect: () => null });
    registry.registerDynamicEventReporter({ name: "r", report: () => {} });

    expect(() => registry.registerFilePreprocessor({ name: "p", test: () => false, process: async () => [] })).toThrow(
      new Error("File preprocessor already registered: p"),
    );
    expect(() => registry.registerSinkDetector(noopSink("s", null))).toThrow(new Error("Sink detector already registered: s"));
    expect(() => registry.registerWrapperDetector({ name: "w", detect: () => null })).toThrow(
      new Error("Wrapper detector already registered: w"),
    );
    expect(() => registry.registerDynamicEventReporter({ name: "r", report: () => {} })).toThrow(
      new Error("Dynamic event reporter already registered: r"),
    );
  });

  it("accepts different names of the same kind and keeps registration order", () => {
    const registry = new PluginRegistry();
    registry.registerFilePreprocessor({ name: "p1", test: () => false, process: async () => [] });
    registry.registerFilePreprocessor({ name: "p2", test: () => false, process: async () => [] });
    registry.registerSinkDetector(noopSink("s1", null));
    registry.registerSinkDetector(noopSink("s2", null));
    registry.registerWrapperDetector({ name: "w1", detect: () => null });
    registry.registerWrapperDetector({ name: "w2", detect: () => null });
    registry.registerDynamicEventReporter({ name: "r1", report: () => {} });
    registry.registerDynamicEventReporter({ name: "r2", report: () => {} });

    expect(registry.getFilePreprocessors().map((p) => p.name)).toEqual(["p1", "p2"]);
    expect(registry.getSinkDetectors().map((d) => d.name)).toEqual(["s1", "s2"]);
    expect(registry.getWrapperDetectors().map((d) => d.name)).toEqual(["w1", "w2"]);
    expect(registry.getDynamicEventReporters().map((r) => r.name)).toEqual(["r1", "r2"]);
  });

  it("starts empty", () => {
    const registry = new PluginRegistry();
    expect(registry.getFilePreprocessors()).toEqual([]);
    expect(registry.getSinkDetectors()).toEqual([]);
    expect(registry.getWrapperDetectors()).toEqual([]);
    expect(registry.getDynamicEventReporters()).toEqual([]);
    expect(registry.getIncludePatterns()).toEqual([]);
  });

  it("stores include patterns trimmed, once each, in order, and ignores blank ones", () => {
    const registry = new PluginRegistry();
    registry.registerIncludePattern("  **/*.vue  ");
    registry.registerIncludePattern("**/*.vue");
    registry.registerIncludePattern("");
    registry.registerIncludePattern("   \t ");
    registry.registerIncludePattern("**/*.svelte");
    expect(registry.getIncludePatterns()).toEqual(["**/*.vue", "**/*.svelte"]);
  });
});

describe("PluginRegistry detectors", () => {
  const context = {} as SinkDetectorContext;

  it("detectSink returns the first detector's hit and does not ask the rest", () => {
    const registry = new PluginRegistry();
    const first = { callee: "first", eventNameArgumentIndex: 0 };
    const second = { callee: "second", eventNameArgumentIndex: 0 };
    const asked: string[] = [];
    registry.registerSinkDetector({ name: "miss", detect: () => (asked.push("miss"), null) });
    registry.registerSinkDetector({ name: "hit", detect: () => (asked.push("hit"), first as never) });
    registry.registerSinkDetector({ name: "later", detect: () => (asked.push("later"), second as never) });

    expect(registry.detectSink(context)).toBe(first);
    expect(asked).toEqual(["miss", "hit"]);
  });

  it("detectSink returns null, not undefined, when nothing matches or nothing is registered", () => {
    const registry = new PluginRegistry();
    expect(registry.detectSink(context)).toBeNull();
    registry.registerSinkDetector(noopSink("miss", null));
    expect(registry.detectSink(context)).toBeNull();
  });

  it("detectWrapper returns the first hit and does not ask the rest", () => {
    const registry = new PluginRegistry();
    const wrapper = { eventNameArgumentIndex: 1 } as never;
    const asked: string[] = [];
    registry.registerWrapperDetector({ name: "miss", detect: () => (asked.push("miss"), null) });
    registry.registerWrapperDetector({ name: "hit", detect: () => (asked.push("hit"), wrapper) });
    registry.registerWrapperDetector({ name: "later", detect: () => (asked.push("later"), null) });

    expect(registry.detectWrapper({} as never)).toBe(wrapper);
    expect(asked).toEqual(["miss", "hit"]);
  });

  it("detectWrapper returns null when nothing matches", () => {
    const registry = new PluginRegistry();
    expect(registry.detectWrapper({} as never)).toBeNull();
  });
});

describe("PluginRegistry.preprocessFile", () => {
  it("asks each preprocessor with the file name, in order, and uses the first non-empty result", async () => {
    const registry = new PluginRegistry();
    const asked: string[] = [];
    const processed: string[] = [];
    const make = (name: string, matches: boolean, produces: boolean): FilePreprocessor => ({
      name,
      test: (fileName) => (asked.push(`${name}:${fileName}`), matches),
      process: async () => (processed.push(name), produces ? [{ fileName: `/p/${name}.ts`, content: name }] : []),
    });
    registry.registerFilePreprocessor(make("skipped", false, true));
    registry.registerFilePreprocessor(make("empty", true, false));
    registry.registerFilePreprocessor(make("winner", true, true));
    registry.registerFilePreprocessor(make("never", true, true));

    const files = await registry.preprocessFile({ fileName: "/p/a.vue", content: "src" });

    expect(files).toEqual([{ fileName: "/p/winner.ts", content: "winner" }]);
    expect(asked).toEqual(["skipped:/p/a.vue", "empty:/p/a.vue", "winner:/p/a.vue"]);
    expect(processed).toEqual(["empty", "winner"]);
  });

  it("passes the input unchanged to the preprocessor", async () => {
    const registry = new PluginRegistry();
    let received: unknown;
    registry.registerFilePreprocessor({
      name: "spy",
      test: () => true,
      process: async (input) => ((received = input), [{ fileName: "/p/x.ts", content: "" }]),
    });
    const input = { fileName: "/p/a.vue", content: "<script/>" };
    await registry.preprocessFile(input);
    expect(received).toBe(input);
  });

  it("passes the file through untouched when no preprocessor produced anything", async () => {
    const registry = new PluginRegistry();
    registry.registerFilePreprocessor({ name: "empty", test: () => true, process: async () => [] });
    expect(await registry.preprocessFile({ fileName: "/p/a.ts", content: "export {}" })).toEqual([
      { fileName: "/p/a.ts", content: "export {}" },
    ]);
    expect(registry.getVirtualPathsForSource("/p/a.ts")).toEqual(["/p/a.ts"]);
  });

  it("normalizes paths: resolves dot segments and turns backslashes into slashes", async () => {
    const registry = await registryWith("/proj\\App.vue", { "/proj\\App.vue.ts": "export {}" });
    expect(registry.getVirtualPathsForSource("/proj/App.vue")).toEqual(["/proj/App.vue.ts"]);
    expect(registry.getVirtualPathsForSource("/proj/other/../App.vue")).toEqual(["/proj/App.vue.ts"]);
  });

  it("records the virtual paths of the latest run only", async () => {
    const registry = new PluginRegistry();
    let names = ["/p/A.vue.ts", "/p/A.vue.template.ts"];
    registry.registerFilePreprocessor({
      name: "fake",
      test: () => true,
      process: async () => names.map((fileName) => ({ fileName, content: "" })),
    });
    await registry.preprocessFile({ fileName: "/p/A.vue", content: "" });
    expect(registry.getVirtualPathsForSource("/p/A.vue")).toEqual(["/p/A.vue.ts", "/p/A.vue.template.ts"]);
    names = ["/p/A.vue.ts"];
    await registry.preprocessFile({ fileName: "/p/A.vue", content: "" });
    expect(registry.getVirtualPathsForSource("/p/A.vue")).toEqual(["/p/A.vue.ts"]);
  });
});

describe("PluginRegistry.runDynamicEventReporters", () => {
  it("returns without calling anything when there are no reporters", async () => {
    await expect(new PluginRegistry().runDynamicEventReporters([occurrence()])).resolves.toBeUndefined();
  });

  it("hands the occurrences over as is (same array) when nothing was preprocessed", async () => {
    const registry = new PluginRegistry();
    const list = [occurrence()];
    let seen: unknown;
    registry.registerDynamicEventReporter({ name: "spy", report: ({ occurrences }) => void (seen = occurrences) });
    await registry.runDynamicEventReporters(list);
    expect(seen).toBe(list);
  });

  it("waits for each reporter to finish before starting the next", async () => {
    const registry = new PluginRegistry();
    const log: string[] = [];
    registry.registerDynamicEventReporter({
      name: "slow",
      report: async () => {
        log.push("slow:start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        log.push("slow:end");
      },
    });
    registry.registerDynamicEventReporter({ name: "fast", report: () => void log.push("fast") });
    await registry.runDynamicEventReporters([]);
    expect(log).toEqual(["slow:start", "slow:end", "fast"]);
  });

  it("does not run later reporters, and rejects, when one throws", async () => {
    const registry = new PluginRegistry();
    const log: string[] = [];
    registry.registerDynamicEventReporter({
      name: "boom",
      report: () => {
        throw new Error("boom");
      },
    });
    registry.registerDynamicEventReporter({ name: "after", report: () => void log.push("after") });
    await expect(registry.runDynamicEventReporters([])).rejects.toThrow("boom");
    expect(log).toEqual([]);
  });
});

describe("PluginRegistry attribution: file and untouched occurrences", () => {
  it("leaves an occurrence in an unrelated file exactly as it was (same object)", async () => {
    const registry = await registryWith("/proj/App.vue", { "/proj/App.vue.ts": "export {}" });
    const other = occurrence({ fileName: "/proj/util.ts", calleeText: "sdk.track" });
    const results = await attribute(registry, other);
    expect(results).toEqual([other]);
    expect(results[0]).toBe(other);
  });

  it("does not remap a module that a plugin emitted under the source's own name", async () => {
    const registry = await registryWith("/proj/App.ts", { "/proj/App.ts": "export {}" });
    const own = occurrence({ fileName: "/proj/App.ts", calleeText: "sdk.track" });
    expect((await attribute(registry, own))[0]).toBe(own);
  });

  it("still remaps the other virtual modules when one of them has the source's own name", async () => {
    const registry = await registryWith("/proj/App.ts", { "/proj/App.ts": "export {}", "/proj/App.ts.extra.ts": "export {}" });
    const [own, extra] = await attribute(
      registry,
      occurrence({ fileName: "/proj/App.ts", calleeText: "sdk.track" }),
      occurrence({ fileName: "/proj/App.ts.extra.ts", calleeText: "sdk.track" }),
    );
    expect(own?.fileName).toBe("/proj/App.ts");
    expect(extra).toEqual(occurrence({ fileName: "/proj/App.ts", calleeText: "sdk.track" }));
  });

  it("maps a virtual module of any of several sources to its own source", async () => {
    const registry = new PluginRegistry();
    registry.registerFilePreprocessor({
      name: "fake",
      test: () => true,
      process: async ({ fileName }) => [{ fileName: `${fileName}.ts`, content: "export {}" }],
    });
    await registry.preprocessFile({ fileName: "/proj/A.vue", content: "" });
    await registry.preprocessFile({ fileName: "/proj/B.vue", content: "" });
    const [a, b] = await attribute(
      registry,
      occurrence({ fileName: "/proj/A.vue.ts", calleeText: "sdk.track" }),
      occurrence({ fileName: "/proj/B.vue.ts", calleeText: "sdk.track" }),
    );
    expect([a?.fileName, b?.fileName]).toEqual(["/proj/A.vue", "/proj/B.vue"]);
  });

  it("finds a virtual module by its normalized path", async () => {
    const registry = await registryWith("/proj/App.vue", { "/proj/App.vue.ts": "export {}" });
    const [result] = await attribute(registry, occurrence({ fileName: "/proj/x/../App.vue.ts", calleeText: "sdk.track" }));
    expect(result?.fileName).toBe("/proj/App.vue");
  });

  it("keeps every other field of a plain occurrence and adds no flags", async () => {
    const registry = await registryWith("/proj/App.vue", { "/proj/App.vue.ts": "export {}" });
    const [result] = await attribute(registry, occurrence({ calleeText: "sdk.track", callText: "sdk.track(x)" }));
    expect(result).toStrictEqual({
      fileName: "/proj/App.vue",
      line: 3,
      character: 7,
      calleeText: "sdk.track",
      callText: "sdk.track(x)",
      resolvedValues: ["a", "b"],
    });
  });
});

describe("PluginRegistry attribution: template callee", () => {
  const registry = () => registryWith("/proj/App.vue", { "/proj/App.vue.ts": "export {}" });

  it("marks a template event, points at the source and extracts the expression", async () => {
    const [result] = await attribute(await registry(), occurrence({ callText: `${VUE_CALLEE}(item.name)` }));
    expect(result).toStrictEqual({
      fileName: "/proj/App.vue",
      line: 3,
      character: 7,
      calleeText: VUE_CALLEE,
      callText: `${VUE_CALLEE}(item.name)`,
      resolvedValues: ["a", "b"],
      inTemplate: true,
      eventExpression: "item.name",
    });
  });

  it("takes everything between the first ( and the last ), so nested calls survive", async () => {
    const [result] = await attribute(await registry(), occurrence({ callText: `${VUE_CALLEE}(fn(a(b)))` }));
    expect(result?.eventExpression).toBe("fn(a(b))");
  });

  it("removes only one closing parenthesis", async () => {
    const [result] = await attribute(await registry(), occurrence({ callText: `${VUE_CALLEE}(a))` }));
    expect(result?.eventExpression).toBe("a)");
  });

  it("keeps a cut-off expression (no closing parenthesis) as it is", async () => {
    const [result] = await attribute(await registry(), occurrence({ callText: `${VUE_CALLEE}(abc…` }));
    expect(result?.eventExpression).toBe("abc…");
  });

  it("falls back to the whole text when there is no parenthesis at all", async () => {
    const [result] = await attribute(await registry(), occurrence({ callText: "someText" }));
    expect(result?.eventExpression).toBe("someText");
  });

  it("strips a trailing ) from text without an opening parenthesis too", async () => {
    const [result] = await attribute(await registry(), occurrence({ callText: "someText)" }));
    expect(result?.eventExpression).toBe("someText");
  });

  it("gives an empty expression for an empty call", async () => {
    const [result] = await attribute(await registry(), occurrence({ callText: `${VUE_CALLEE}()` }));
    expect(result?.eventExpression).toBe("");
  });

  it("does not drop a leading this. for non-Angular templates", async () => {
    const [result] = await attribute(await registry(), occurrence({ callText: `${VUE_CALLEE}(this.name)` }));
    expect(result?.eventExpression).toBe("this.name");
  });

  it("drops a leading this. for Angular templates, and only a leading one", async () => {
    const reg = await registry();
    const [bare, inner, plain, thisOnly] = await attribute(
      reg,
      occurrence({ calleeText: NG_CALLEE, callText: `${NG_CALLEE}(this.title)` }),
      occurrence({ calleeText: NG_CALLEE, callText: `${NG_CALLEE}(a.this.title)` }),
      occurrence({ calleeText: NG_CALLEE, callText: `${NG_CALLEE}(title)` }),
      occurrence({ calleeText: NG_CALLEE, callText: `${NG_CALLEE}(thisx)` }),
    );
    expect([bare, inner, plain, thisOnly].map((o) => o?.eventExpression)).toEqual(["title", "a.this.title", "title", "thisx"]);
  });

  it("only treats `this.` followed by a dot as the Angular qualifier", async () => {
    const [result] = await attribute(await registry(), occurrence({ calleeText: NG_CALLEE, callText: `${NG_CALLEE}(thisname)` }));
    expect(result?.eventExpression).toBe("thisname");
  });

  it("recognises the template callee of every framework: lowercase letters between __eventra_ and _template_event__", async () => {
    const reg = await registry();
    const callees = [
      "__eventra_vue_template_event__",
      "__eventra_svelte_template_event__",
      "__eventra_astro_template_event__",
      "__eventra_angular_template_event__",
    ];
    const results = await attribute(reg, ...callees.map((calleeText) => occurrence({ calleeText, callText: `${calleeText}(x)` })));
    expect(results.map((o) => o.inTemplate)).toEqual([true, true, true, true]);
  });

  it.each([
    ["a prefix", `x${VUE_CALLEE}`],
    ["a suffix", `${VUE_CALLEE}x`],
    ["an uppercase framework", "__eventra_Vue_template_event__"],
    ["a digit in the framework", "__eventra_vue2_template_event__"],
    ["an empty framework", "__eventra__template_event__"],
    ["a missing underscore", "__eventra_vue_template_event_"],
    ["a different event suffix", "__eventra_vue_template_events__"],
    ["a dotted callee", `sdk.${VUE_CALLEE}`],
    ["a newline before it", `\n${VUE_CALLEE}`],
    ["a newline after it", `${VUE_CALLEE}\n`],
  ])("does not treat %s as the template callee", async (_label, calleeText) => {
    const [result] = await attribute(await registry(), occurrence({ calleeText, callText: `${calleeText}(x)` }));
    expect(result?.inTemplate).toBeUndefined();
    expect(result?.eventExpression).toBeUndefined();
    expect(result?.fileName).toBe("/proj/App.vue");
  });
});

describe("PluginRegistry attribution: generated template region", () => {
  const module = (...lines: string[]) => lines.join("\n");

  it("flags a call on the start-marker line and on the end-marker line, nowhere else", async () => {
    const registry = await registryWith(
      "/proj/App.vue",
      // 1: code, 2: start, 3: generated, 4: end, 5: code
      { "/proj/App.vue.ts": module("code", REGION_START, "gen", REGION_END, "code") },
    );
    const lines = [1, 2, 3, 4, 5];
    const results = await attribute(registry, ...lines.map((line) => occurrence({ line, calleeText: "sdk.track" })));
    expect(results.map((o) => o.inTemplateCode)).toEqual([undefined, true, true, true, undefined]);
  });

  it("flags with inTemplateCode and the source file, without touching other fields", async () => {
    const registry = await registryWith("/proj/App.vue", { "/proj/App.vue.ts": module(REGION_START, "gen", REGION_END) });
    const [result] = await attribute(registry, occurrence({ line: 2, calleeText: "sdk.track", callText: "sdk.track(x)" }));
    expect(result).toStrictEqual({
      fileName: "/proj/App.vue",
      line: 2,
      character: 7,
      calleeText: "sdk.track",
      callText: "sdk.track(x)",
      resolvedValues: ["a", "b"],
      inTemplateCode: true,
    });
  });

  it("without an end marker, everything from the start marker on is generated", async () => {
    const registry = await registryWith("/proj/App.vue", { "/proj/App.vue.ts": module("code", REGION_START, "gen") });
    const results = await attribute(
      registry,
      occurrence({ line: 1, calleeText: "sdk.track" }),
      occurrence({ line: 2, calleeText: "sdk.track" }),
      occurrence({ line: 1000, calleeText: "sdk.track" }),
    );
    expect(results.map((o) => o.inTemplateCode)).toEqual([undefined, true, true]);
  });

  it("an end marker before the start marker does not close the region", async () => {
    const registry = await registryWith("/proj/App.vue", {
      "/proj/App.vue.ts": module(REGION_END, REGION_START, "gen", "more"),
    });
    const results = await attribute(
      registry,
      occurrence({ line: 1, calleeText: "sdk.track" }),
      occurrence({ line: 3, calleeText: "sdk.track" }),
      occurrence({ line: 4, calleeText: "sdk.track" }),
    );
    expect(results.map((o) => o.inTemplateCode)).toEqual([undefined, true, true]);
  });

  it("the first end marker after the start closes the region", async () => {
    const registry = await registryWith("/proj/App.vue", {
      "/proj/App.vue.ts": module(REGION_START, REGION_END, "code", REGION_END),
    });
    const results = await attribute(
      registry,
      occurrence({ line: 2, calleeText: "sdk.track" }),
      occurrence({ line: 3, calleeText: "sdk.track" }),
    );
    expect(results.map((o) => o.inTemplateCode)).toEqual([true, undefined]);
  });

  it("the first start marker wins when there are several", async () => {
    const registry = await registryWith("/proj/App.vue", {
      "/proj/App.vue.ts": module("code", REGION_START, "gen", REGION_END, REGION_START, "gen"),
    });
    const results = await attribute(
      registry,
      occurrence({ line: 1, calleeText: "sdk.track" }),
      occurrence({ line: 5, calleeText: "sdk.track" }),
    );
    expect(results.map((o) => o.inTemplateCode)).toEqual([undefined, undefined]);
  });

  it("accepts indented markers and any lowercase framework name", async () => {
    const registry = await registryWith("/proj/App.vue", {
      "/proj/App.vue.ts": module("class A {", "  \t// --- angular template (auto-generated) ---", "  gen", "  // --- end template ---", "}"),
    });
    const results = await attribute(
      registry,
      occurrence({ line: 2, calleeText: "sdk.track" }),
      occurrence({ line: 4, calleeText: "sdk.track" }),
      occurrence({ line: 5, calleeText: "sdk.track" }),
    );
    expect(results.map((o) => o.inTemplateCode)).toEqual([true, true, undefined]);
  });

  it.each([
    ["text before the marker", `x ${REGION_START}`],
    ["text after the marker", `${REGION_START} x`],
    ["trailing whitespace after the marker", `${REGION_START} `],
    ["an uppercase framework", "// --- Vue template (auto-generated) ---"],
    ["a digit in the framework", "// --- vue2 template (auto-generated) ---"],
    ["an empty framework", "// ---  template (auto-generated) ---"],
    ["a different comment", "// --- vue template ---"],
    ["a block comment", "/* --- vue template (auto-generated) --- */"],
  ])("does not start a region on %s", async (_label, line) => {
    const registry = await registryWith("/proj/App.vue", { "/proj/App.vue.ts": module("code", line, "gen") });
    const [result] = await attribute(registry, occurrence({ line: 3, calleeText: "sdk.track" }));
    expect(result?.inTemplateCode).toBeUndefined();
  });

  it.each([
    ["text before the marker", `x ${REGION_END}`],
    ["text after the marker", `${REGION_END} x`],
    ["a different wording", "// --- end of template ---"],
  ])("does not end a region on %s", async (_label, line) => {
    const registry = await registryWith("/proj/App.vue", {
      "/proj/App.vue.ts": module(REGION_START, line, "still generated"),
    });
    const [result] = await attribute(registry, occurrence({ line: 3, calleeText: "sdk.track" }));
    expect(result?.inTemplateCode).toBe(true);
  });

  it("keeps a separate region per virtual module", async () => {
    const registry = await registryWith("/proj/App.vue", {
      "/proj/App.vue.ts": module(REGION_START, "gen"),
      "/proj/App.vue.other.ts": module("code", "code"),
    });
    const [withRegion, without] = await attribute(
      registry,
      occurrence({ fileName: "/proj/App.vue.ts", line: 2, calleeText: "sdk.track" }),
      occurrence({ fileName: "/proj/App.vue.other.ts", line: 2, calleeText: "sdk.track" }),
    );
    expect([withRegion?.inTemplateCode, without?.inTemplateCode]).toEqual([true, undefined]);
  });

  it("a template callee inside the region is still a template event, not template code", async () => {
    const registry = await registryWith("/proj/App.vue", { "/proj/App.vue.ts": module(REGION_START, "gen", REGION_END) });
    const [result] = await attribute(registry, occurrence({ line: 2 }));
    expect(result?.inTemplate).toBe(true);
    expect(result?.inTemplateCode).toBeUndefined();
  });

  it("drops the region when the same module is generated again without one", async () => {
    const registry = new PluginRegistry();
    let content = module(REGION_START, "gen");
    registry.registerFilePreprocessor({
      name: "fake",
      test: () => true,
      process: async () => [{ fileName: "/proj/App.vue.ts", content }],
    });
    await registry.preprocessFile({ fileName: "/proj/App.vue", content: "" });
    content = module("code", "code");
    await registry.preprocessFile({ fileName: "/proj/App.vue", content: "" });
    const [result] = await attribute(registry, occurrence({ line: 2, calleeText: "sdk.track" }));
    expect(result?.inTemplateCode).toBeUndefined();
  });

  it("replaces the region when the same module is generated again with a different one", async () => {
    const registry = new PluginRegistry();
    let content = module(REGION_START, "gen", REGION_END, "code");
    registry.registerFilePreprocessor({
      name: "fake",
      test: () => true,
      process: async () => [{ fileName: "/proj/App.vue.ts", content }],
    });
    await registry.preprocessFile({ fileName: "/proj/App.vue", content: "" });
    content = module("code", "code", REGION_START, "gen");
    await registry.preprocessFile({ fileName: "/proj/App.vue", content: "" });
    const results = await attribute(
      registry,
      occurrence({ line: 2, calleeText: "sdk.track" }),
      occurrence({ line: 4, calleeText: "sdk.track" }),
    );
    expect(results.map((o) => o.inTemplateCode)).toEqual([undefined, true]);
  });

  it("a module that another source now generates without a region loses the old region", async () => {
    const registry = new PluginRegistry();
    const generated: Record<string, string> = {
      "/proj/A.vue": module(REGION_START, "gen"),
      "/proj/B.vue": module("code", "code"),
    };
    registry.registerFilePreprocessor({
      name: "fake",
      test: () => true,
      process: async ({ fileName }) => [{ fileName: "/proj/shared.ts", content: generated[fileName] ?? "" }],
    });
    await registry.preprocessFile({ fileName: "/proj/A.vue", content: "" });
    await registry.preprocessFile({ fileName: "/proj/B.vue", content: "" });
    const [result] = await attribute(registry, occurrence({ fileName: "/proj/shared.ts", line: 2, calleeText: "sdk.track" }));
    expect(result).toStrictEqual(occurrence({ fileName: "/proj/B.vue", line: 2, calleeText: "sdk.track" }));
  });

  it("forgets the regions of a source that stopped producing virtual modules", async () => {
    const registry = new PluginRegistry();
    let active = true;
    registry.registerFilePreprocessor({
      name: "fake",
      test: () => active,
      process: async () => [{ fileName: "/proj/App.vue.ts", content: module(REGION_START, "gen") }],
    });
    await registry.preprocessFile({ fileName: "/proj/App.vue", content: "" });
    active = false;
    await registry.preprocessFile({ fileName: "/proj/App.vue", content: "" });
    // the module is no longer attributed to the source at all
    const stray = occurrence({ line: 2, calleeText: "sdk.track" });
    expect((await attribute(registry, stray))[0]).toBe(stray);
  });
});

describe("PluginRegistry attribution: Angular template modules", () => {
  it("flags a call outside any region as generated code when the source is an .html file", async () => {
    const registry = await registryWith("/proj/app.component.html", { "/proj/app.component.html.ts": "export {}" });
    const [result] = await attribute(registry, occurrence({ fileName: "/proj/app.component.html.ts", calleeText: "sdk.track" }));
    expect(result).toStrictEqual({
      fileName: "/proj/app.component.html",
      line: 3,
      character: 7,
      calleeText: "sdk.track",
      callText: `${VUE_CALLEE}(name)`,
      resolvedValues: ["a", "b"],
      inGeneratedCode: true,
    });
  });

  it("matches the .html extension case-insensitively", async () => {
    const registry = await registryWith("/proj/App.HTML", { "/proj/App.HTML.ts": "export {}" });
    const [result] = await attribute(registry, occurrence({ fileName: "/proj/App.HTML.ts", calleeText: "sdk.track" }));
    expect(result?.inGeneratedCode).toBe(true);
  });

  it.each(["/proj/App.vue", "/proj/page.html.vue", "/proj/htmlfile", "/proj/App.xhtml"])(
    "does not flag generated code for the source %s",
    async (source) => {
      const registry = await registryWith(source, { [`${source}.ts`]: "export {}" });
      const [result] = await attribute(registry, occurrence({ fileName: `${source}.ts`, calleeText: "sdk.track" }));
      expect(result?.inGeneratedCode).toBeUndefined();
      expect(result?.fileName).toBe(source);
    },
  );

  it("prefers the template-region flag over the generated-code flag", async () => {
    const registry = await registryWith("/proj/app.component.html", {
      "/proj/app.component.html.ts": [REGION_START, "gen", REGION_END].join("\n"),
    });
    const [result] = await attribute(registry, occurrence({ fileName: "/proj/app.component.html.ts", line: 2, calleeText: "sdk.track" }));
    expect(result?.inTemplateCode).toBe(true);
    expect(result?.inGeneratedCode).toBeUndefined();
  });
});
