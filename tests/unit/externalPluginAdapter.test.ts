import { describe, expect, it } from "vitest";

import { isExternalCliPlugin, registerExternalCliPlugin } from "../../src/plugin/adapters/external";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import type { ExternalCliPlugin } from "../../src/plugin/adapters/external";

const validPlugin: ExternalCliPlugin = {
  id: "valid",
  includeGlobs: ["**/*.vue"],
  match: () => true,
  transform: async () => ({ modules: [] }),
};

describe("registerExternalCliPlugin", () => {
  it("maps plugin transform output to internal virtual files", async () => {
    const registry = createBuiltinPluginRegistry();
    const plugin: ExternalCliPlugin = {
      id: "test-vue",
      includeGlobs: ["**/*.vue"],
      staticSinks: [
        {
          id: "test-template",
          callee: "__test_template_event__",
          eventNameArgumentIndex: 0,
        },
      ],
      match: (path) => path.endsWith(".vue"),
      transform: async ({ path }) => ({
        modules: [{ path: `${path}.ts`, content: 'sdk.track("from.vue");' }],
      }),
    };

    registerExternalCliPlugin(plugin, registry);

    const files = await registry.preprocessFile({
      fileName: "/app/Button.vue",
      content: "<script />",
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.fileName).toBe("/app/Button.vue.ts");
    expect(registry.getIncludePatterns()).toContain("**/*.vue");
    expect(registry.getSinkDetectors().map((d) => d.name)).toContain("test-template");
  });

  it("rejects invalid transform results", async () => {
    const registry = createBuiltinPluginRegistry();
    const plugin: ExternalCliPlugin = {
      id: "bad",
      includeGlobs: [],
      match: () => true,
      transform: async () => ({ modules: null as unknown as [] }),
    };

    registerExternalCliPlugin(plugin, registry);

    await expect(
      registry.preprocessFile({ fileName: "/x.ts", content: "" }),
    ).rejects.toThrow(/invalid transform result/);
  });

  it("rejects when a transform result module entry isn't an object", async () => {
    const registry = createBuiltinPluginRegistry();
    const plugin: ExternalCliPlugin = {
      id: "bad-module-entry",
      includeGlobs: [],
      match: () => true,
      transform: async () => ({ modules: ["not-an-object"] as unknown as [] }),
    };

    registerExternalCliPlugin(plugin, registry);

    await expect(
      registry.preprocessFile({ fileName: "/x.ts", content: "" }),
    ).rejects.toThrow(/module at index 0 is invalid/);
  });

  it("rejects when a transform result module entry has non-string path/content", async () => {
    const registry = createBuiltinPluginRegistry();
    const plugin: ExternalCliPlugin = {
      id: "bad-module-fields",
      includeGlobs: [],
      match: () => true,
      transform: async () => ({ modules: [{ path: 123, content: {} }] as unknown as [] }),
    };

    registerExternalCliPlugin(plugin, registry);

    await expect(
      registry.preprocessFile({ fileName: "/x.ts", content: "" }),
    ).rejects.toThrow(/module at index 0 must have string path and content/);
  });

  it("wraps a thrown Error from transform() with the plugin id and file name", async () => {
    const registry = createBuiltinPluginRegistry();
    const plugin: ExternalCliPlugin = {
      id: "throwing-plugin",
      includeGlobs: [],
      match: () => true,
      transform: async () => {
        throw new Error("kaboom");
      },
    };

    registerExternalCliPlugin(plugin, registry);

    await expect(
      registry.preprocessFile({ fileName: "/x.ts", content: "" }),
    ).rejects.toThrow(/Plugin "throwing-plugin" failed to transform \/x\.ts: kaboom/);
  });

  it("wraps a thrown non-Error value from transform() via String()", async () => {
    const registry = createBuiltinPluginRegistry();
    const plugin: ExternalCliPlugin = {
      id: "throwing-plugin-non-error",
      includeGlobs: [],
      match: () => true,
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      transform: async () => {
        throw "raw-string-failure";
      },
    };

    registerExternalCliPlugin(plugin, registry);

    await expect(
      registry.preprocessFile({ fileName: "/x.ts", content: "" }),
    ).rejects.toThrow(/Plugin "throwing-plugin-non-error" failed to transform \/x\.ts: raw-string-failure/);
  });

  it("throws when registered directly with a staticSink of an invalid shape (defense in depth)", () => {
    const registry = createBuiltinPluginRegistry();
    const plugin: ExternalCliPlugin = {
      id: "invalid-static-sink",
      includeGlobs: [],
      // Deliberately bypasses isExternalCliPlugin's own validation to exercise
      // registerExternalCliPlugin's independent re-check of each staticSink.
      staticSinks: [{ id: "", callee: "foo", eventNameArgumentIndex: 0 }],
      match: () => true,
      transform: async () => ({ modules: [] }),
    };

    expect(() => registerExternalCliPlugin(plugin, registry)).toThrow(/invalid staticSink/);
  });
});

describe("isExternalCliPlugin", () => {
  it("accepts a well-formed plugin, with and without staticSinks", () => {
    expect(isExternalCliPlugin(validPlugin)).toBe(true);
    expect(
      isExternalCliPlugin({
        ...validPlugin,
        staticSinks: [{ id: "s", callee: "c", eventNameArgumentIndex: 0 }],
      }),
    ).toBe(true);
  });

  it("rejects non-object values", () => {
    expect(isExternalCliPlugin(null)).toBe(false);
    expect(isExternalCliPlugin(undefined)).toBe(false);
    expect(isExternalCliPlugin("a string")).toBe(false);
    expect(isExternalCliPlugin(42)).toBe(false);
  });

  it("rejects a missing or blank id", () => {
    expect(isExternalCliPlugin({ ...validPlugin, id: undefined })).toBe(false);
    expect(isExternalCliPlugin({ ...validPlugin, id: "   " })).toBe(false);
    expect(isExternalCliPlugin({ ...validPlugin, id: 5 })).toBe(false);
  });

  it("rejects includeGlobs that isn't an array of strings", () => {
    expect(isExternalCliPlugin({ ...validPlugin, includeGlobs: "not-an-array" })).toBe(false);
    expect(isExternalCliPlugin({ ...validPlugin, includeGlobs: [1, 2] })).toBe(false);
  });

  it("rejects a staticSinks that isn't an array, or that contains an invalid entry", () => {
    expect(isExternalCliPlugin({ ...validPlugin, staticSinks: "nope" })).toBe(false);
    expect(isExternalCliPlugin({ ...validPlugin, staticSinks: [null] })).toBe(false);
    expect(
      isExternalCliPlugin({ ...validPlugin, staticSinks: [{ id: "", callee: "c", eventNameArgumentIndex: 0 }] }),
    ).toBe(false);
    expect(
      isExternalCliPlugin({
        ...validPlugin,
        staticSinks: [{ id: "s", callee: "", eventNameArgumentIndex: 0 }],
      }),
    ).toBe(false);
    expect(
      isExternalCliPlugin({
        ...validPlugin,
        staticSinks: [{ id: "s", callee: "c", eventNameArgumentIndex: -1 }],
      }),
    ).toBe(false);
    expect(
      isExternalCliPlugin({
        ...validPlugin,
        staticSinks: [{ id: "s", callee: "c", eventNameArgumentIndex: 1.5 }],
      }),
    ).toBe(false);
  });

  it("rejects a missing match or transform function", () => {
    expect(isExternalCliPlugin({ ...validPlugin, match: undefined })).toBe(false);
    expect(isExternalCliPlugin({ ...validPlugin, transform: undefined })).toBe(false);
  });
});
