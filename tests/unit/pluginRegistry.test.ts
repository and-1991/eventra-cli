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

  it("deduplicates include patterns", () => {
    const registry = createBuiltinPluginRegistry();
    registry.registerIncludePattern("**/*.vue");
    registry.registerIncludePattern("**/*.vue");
    expect(registry.getIncludePatterns()).toEqual(["**/*.vue"]);
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
