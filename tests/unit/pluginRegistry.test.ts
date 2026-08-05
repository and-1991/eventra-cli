import path from "path";

import { describe, expect, it } from "vitest";

import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import type {
  DynamicEventReporter,
  FilePreprocessor,
  WrapperDetector,
  WrapperDetectorContext,
} from "../../src/plugin/types";
import type { WrapperSemanticInfo } from "../../src/analysis/shared/propagation";
import type { DynamicOccurrence } from "../../src/analysis/shared/dynamicOccurrence";

describe("PluginRegistry", () => {
  it("registers built-in eventra-sdk sink detector", () => {
    const registry = createBuiltinPluginRegistry();
    expect(registry.getSinkDetectors().map((d) => d.name)).toContain("eventra-sdk");
  });

  it("runs file preprocessors before default passthrough", async () => {
    const registry = createBuiltinPluginRegistry();
    const preprocessor: FilePreprocessor = {
      name: "test-vue",
      test: (fileName) => fileName.endsWith(".vue"),
      process: async ({ fileName }) => [
        {
          fileName: `${fileName}.virtual.ts`,
          content: `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk = new Eventra({ apiKey: "k" });
            sdk.track("from.vue");
          `,
        },
      ],
    };
    registry.registerFilePreprocessor(preprocessor);
    registry.registerIncludePattern("**/*.vue");

    const files = await registry.preprocessFile({
      fileName: "/app/Button.vue",
      content: "<script />",
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.fileName).toContain(".vue.virtual.ts");
    expect(registry.getIncludePatterns()).toContain("**/*.vue");
  });

  it("tracks virtual paths for a preprocessed source file", async () => {
    const registry = createBuiltinPluginRegistry();
    registry.registerFilePreprocessor({
      name: "vue",
      test: (fileName) => fileName.endsWith(".vue"),
      process: async ({ fileName }) => [
        { fileName: `${fileName}.ts`, content: "export {}" },
        { fileName: `${fileName}.template.ts`, content: "export {}" },
      ],
    });

    await registry.preprocessFile({
      fileName: "/app/Button.vue",
      content: "<script />",
    });

    expect(registry.getVirtualPathsForSource("/app/Button.vue")).toEqual([
      "/app/Button.vue.ts",
      "/app/Button.vue.template.ts",
    ]);
  });

  it("falls back to the source file's own normalized path when it has never been preprocessed", () => {
    const registry = createBuiltinPluginRegistry();
    expect(registry.getVirtualPathsForSource("/app/never-touched.ts")).toEqual([
      path.resolve("/app/never-touched.ts").replace(/\\/g, "/"),
    ]);
  });

  it("falls through to the default passthrough when no preprocessor's test() matches", async () => {
    const registry = createBuiltinPluginRegistry();
    registry.registerFilePreprocessor({
      name: "vue-only",
      test: (fileName) => fileName.endsWith(".vue"),
      process: async ({ fileName }) => [{ fileName: `${fileName}.virtual.ts`, content: "export {}" }],
    });

    const files = await registry.preprocessFile({
      fileName: "/app/plain.ts",
      content: "export const x = 1;",
    });

    expect(files).toEqual([{ fileName: "/app/plain.ts", content: "export const x = 1;" }]);
    // No virtual mapping was recorded for this source, so lookups fall back too.
    expect(registry.getVirtualPathsForSource("/app/plain.ts")).toEqual([
      path.resolve("/app/plain.ts").replace(/\\/g, "/"),
    ]);
  });

  it("moves on to the next preprocessor when one matches but returns no virtual files", async () => {
    const registry = createBuiltinPluginRegistry();
    registry.registerFilePreprocessor({
      name: "matches-but-empty",
      test: () => true,
      process: async () => [],
    });
    registry.registerFilePreprocessor({
      name: "matches-and-produces",
      test: () => true,
      process: async ({ fileName }) => [{ fileName: `${fileName}.ts`, content: "export {}" }],
    });

    const files = await registry.preprocessFile({
      fileName: "/app/Widget.vue",
      content: "<script />",
    });

    expect(files).toEqual([{ fileName: "/app/Widget.vue.ts", content: "export {}" }]);
  });

  it("clears a stale virtual-path mapping when a source no longer matches any preprocessor", async () => {
    const registry = createBuiltinPluginRegistry();
    let shouldMatch = true;
    registry.registerFilePreprocessor({
      name: "toggle",
      test: () => shouldMatch,
      process: async ({ fileName }) => [{ fileName: `${fileName}.ts`, content: "export {}" }],
    });

    await registry.preprocessFile({ fileName: "/app/Toggle.vue", content: "<script />" });
    expect(registry.getVirtualPathsForSource("/app/Toggle.vue")).toEqual([
      path.resolve("/app/Toggle.vue.ts").replace(/\\/g, "/"),
    ]);

    shouldMatch = false;
    await registry.preprocessFile({ fileName: "/app/Toggle.vue", content: "<script />" });
    expect(registry.getVirtualPathsForSource("/app/Toggle.vue")).toEqual([
      path.resolve("/app/Toggle.vue").replace(/\\/g, "/"),
    ]);
  });

  it("deduplicates include patterns", () => {
    const registry = createBuiltinPluginRegistry();
    registry.registerIncludePattern("**/*.vue");
    registry.registerIncludePattern("**/*.vue");
    expect(registry.getIncludePatterns()).toEqual(["**/*.vue"]);
  });

  it("ignores a blank include pattern instead of registering it", () => {
    const registry = createBuiltinPluginRegistry();
    registry.registerIncludePattern("   ");
    expect(registry.getIncludePatterns()).toEqual([]);
  });

  it("throws when a file preprocessor with the same name is registered twice", () => {
    const registry = createBuiltinPluginRegistry();
    const preprocessor: FilePreprocessor = {
      name: "dup-preprocessor",
      test: () => true,
      process: async ({ fileName, content }) => [{ fileName, content }],
    };
    registry.registerFilePreprocessor(preprocessor);
    expect(() => registry.registerFilePreprocessor(preprocessor)).toThrow(/already registered/);
  });

  it("throws when a sink detector with the same name is registered twice", () => {
    const registry = createBuiltinPluginRegistry();
    expect(() =>
      registry.registerSinkDetector({ name: "eventra-sdk", detect: () => null }),
    ).toThrow(/already registered/);
  });

  describe("wrapper detector", () => {
    const fakeContext = {
      fn: {} as WrapperDetectorContext["fn"],
      checker: {} as WrapperDetectorContext["checker"],
      sinks: [],
    };
    const fakeSemanticInfo = {} as WrapperSemanticInfo;

    it("returns a matching detector's result", () => {
      const registry = createBuiltinPluginRegistry();
      const detector: WrapperDetector = {
        name: "test-wrapper-detector",
        detect: () => fakeSemanticInfo,
      };
      registry.registerWrapperDetector(detector);

      expect(registry.detectWrapper(fakeContext)).toBe(fakeSemanticInfo);
      expect(registry.getWrapperDetectors().map((d) => d.name)).toContain("test-wrapper-detector");
    });

    it("returns null when no detector matches, so the built-in analyzer can run as fallback", () => {
      const registry = createBuiltinPluginRegistry();
      registry.registerWrapperDetector({ name: "no-match", detect: () => null });

      expect(registry.detectWrapper(fakeContext)).toBeNull();
    });

    it("throws when a detector with the same name is registered twice", () => {
      const registry = createBuiltinPluginRegistry();
      registry.registerWrapperDetector({ name: "dup", detect: () => null });
      expect(() => registry.registerWrapperDetector({ name: "dup", detect: () => null })).toThrow(
        /already registered/,
      );
    });
  });

  describe("dynamic event reporter", () => {
    const occurrences: readonly DynamicOccurrence[] = [
      {
        fileName: "/app/checkout.ts",
        line: 10,
        character: 4,
        calleeText: "sdk.track",
        callText: "sdk.track(`checkout:${name}`)",
        resolvedValues: ["checkout:done"],
      },
    ];

    it("invokes every registered reporter, in order, with the full occurrence list", async () => {
      const registry = createBuiltinPluginRegistry();
      const calls: string[] = [];
      const reporterA: DynamicEventReporter = {
        name: "a",
        report: ({ occurrences: seen }) => {
          calls.push("a");
          expect(seen).toBe(occurrences);
        },
      };
      const reporterB: DynamicEventReporter = {
        name: "b",
        report: ({ occurrences: seen }) => {
          calls.push("b");
          expect(seen).toBe(occurrences);
        },
      };
      registry.registerDynamicEventReporter(reporterA);
      registry.registerDynamicEventReporter(reporterB);

      await registry.runDynamicEventReporters(occurrences);

      expect(calls).toEqual(["a", "b"]);
      // createBuiltinPluginRegistry() already registers the built-in "console"
      // reporter, so "a"/"b" are appended after it.
      expect(registry.getDynamicEventReporters().map((r) => r.name)).toEqual(["console", "a", "b"]);
    });

    it("throws when a reporter with the same name is registered twice", () => {
      const registry = createBuiltinPluginRegistry();
      registry.registerDynamicEventReporter({ name: "dup", report: () => {} });
      expect(() =>
        registry.registerDynamicEventReporter({ name: "dup", report: () => {} }),
      ).toThrow(/already registered/);
    });
  });
});
