import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginRegistry, isTrustedPluginSpecifier } from "../../src/plugin/loadPlugins";
import { normalizeConfig } from "../../src/config/config";
import type { EventraConfig } from "../../src/types";

// Fixtures for exercising the real `import()` path in loadExternalPlugin.
// These specifiers all match the @eventra_dev/cli-plugin-* allowlist shape
// (isTrustedPluginSpecifier) so createPluginRegistry actually attempts to
// import() them — vi.mock intercepts the dynamic import with a virtual
// module since none of these packages exist on disk.
vi.mock("@eventra_dev/cli-plugin-fixture-valid", () => ({
  default: {
    id: "fixture-valid-plugin",
    includeGlobs: ["**/*.fixture"],
    match: () => false,
    transform: async () => ({ modules: [] }),
  },
}));

vi.mock("@eventra_dev/cli-plugin-fixture-factory", () => ({
  default: () => ({
    id: "fixture-factory-plugin",
    includeGlobs: [],
    match: () => false,
    transform: async () => ({ modules: [] }),
  }),
}));

vi.mock("@eventra_dev/cli-plugin-fixture-async-factory", () => ({
  default: async () => ({
    id: "fixture-async-factory-plugin",
    includeGlobs: [],
    match: () => false,
    transform: async () => ({ modules: [] }),
  }),
}));

// No `default` export at all — resolvePluginExport must fall back to the
// module object itself (`mod.default ?? mod`). vitest's mocked-module proxy
// throws on access to any export not explicitly declared in the factory, so
// every property the plugin contract touches must be listed (even as
// `undefined`) instead of just omitting `default`.
vi.mock("@eventra_dev/cli-plugin-fixture-no-default", () => ({
  default: undefined,
  id: "fixture-no-default-plugin",
  includeGlobs: [],
  staticSinks: undefined,
  match: () => false,
  transform: async () => ({ modules: [] }),
}));

vi.mock("@eventra_dev/cli-plugin-fixture-invalid-shape", () => ({
  default: { id: "fixture-invalid-shape", includeGlobs: [] }, // missing match/transform
}));

vi.mock("@eventra_dev/cli-plugin-fixture-import-throws", () => {
  throw new Error("boom-import");
});

describe("isTrustedPluginSpecifier", () => {
  it("accepts official @eventra_dev/cli-plugin-* names", () => {
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-vue")).toBe(true);
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-svelte")).toBe(true);
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-my-framework")).toBe(true);
  });

  it("rejects anything outside the @eventra_dev/cli-plugin-* shape", () => {
    expect(isTrustedPluginSpecifier("some-malicious-package")).toBe(false);
    expect(isTrustedPluginSpecifier("@eventra_dev/eventra-sdk")).toBe(false);
    expect(isTrustedPluginSpecifier("@other-scope/cli-plugin-vue")).toBe(false);
    expect(isTrustedPluginSpecifier("./local-file.js")).toBe(false);
    expect(isTrustedPluginSpecifier("../evil.js")).toBe(false);
    expect(isTrustedPluginSpecifier("/abs/path/evil.js")).toBe(false);
    expect(isTrustedPluginSpecifier("file:./evil.js")).toBe(false);
    expect(isTrustedPluginSpecifier("http://evil.example.com/x.js")).toBe(false);
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-")).toBe(false);
  });

  it("rejects path-traversal and near-miss shapes that could smuggle code past a naive check", () => {
    // Uppercase / mixed-case package name segments are not valid trusted
    // specifiers — npm package names are lowercase-only, and loosening the
    // regex to accept them would widen what a committed eventra.json could
    // trigger.
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-Vue")).toBe(false);
    // Path traversal / extra path segments appended to an otherwise-trusted
    // prefix must still be rejected outright by the regex (no partial-match
    // bypass via a trailing slash or "..").
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-../evil")).toBe(false);
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-vue/../../evil")).toBe(false);
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-vue/../evil")).toBe(false);
    // Scoped-but-wrong-org: same package "leaf" name, different scope.
    expect(isTrustedPluginSpecifier("@eventra-dev/cli-plugin-vue")).toBe(false);
    expect(isTrustedPluginSpecifier("@eventra_dev_evil/cli-plugin-vue")).toBe(false);
    // file:/http(s): specifiers, including ones that otherwise look trusted.
    expect(isTrustedPluginSpecifier("file:@eventra_dev/cli-plugin-vue")).toBe(false);
    expect(isTrustedPluginSpecifier("https://evil.example.com/@eventra_dev/cli-plugin-vue")).toBe(
      false,
    );
    // Trailing/leading whitespace or a version specifier must not sneak past
    // the exact-match anchors.
    expect(isTrustedPluginSpecifier(" @eventra_dev/cli-plugin-vue")).toBe(false);
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-vue ")).toBe(false);
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-vue@1.0.0")).toBe(false);
    // Double-dash / empty segment shapes.
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin--vue")).toBe(false);
    expect(isTrustedPluginSpecifier("@eventra_dev/cli-plugin-vue-")).toBe(false);
  });
});

describe("createPluginRegistry — plugin allowlist", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips untrusted plugin specifiers with a warning instead of importing them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeConfig({ plugins: ["some-malicious-package"] });

    const registry = await createPluginRegistry(config);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("some-malicious-package");
    expect(warn.mock.calls[0]?.[0]).toContain("@eventra_dev/cli-plugin-*");
    // still returns a usable registry with just the built-ins
    expect(registry.getIncludePatterns()).not.toContain("**/*.vue");
  });

  it("ignores blank plugin entries silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeConfig({ plugins: ["  "] });

    await createPluginRegistry(config);

    expect(warn).not.toHaveBeenCalled();
  });

  it("suggests the official vue plugin name when an untrusted specifier looks like a vue-plugin typo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeConfig({ plugins: ["eventra-plugin-vue"] });

    await createPluginRegistry(config);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Did you mean @eventra_dev/cli-plugin-vue?");
  });

  it("does not append a hint for an unrelated untrusted specifier", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeConfig({ plugins: ["some-malicious-package"] });

    await createPluginRegistry(config);

    expect(warn.mock.calls[0]?.[0]).not.toContain("Did you mean");
  });
});

describe("createPluginRegistry — trusted specifier import path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports a trusted specifier and registers its plugin (default export, plain object)", async () => {
    const config = normalizeConfig({ plugins: ["@eventra_dev/cli-plugin-fixture-valid"] });

    const registry = await createPluginRegistry(config);

    expect(registry.getIncludePatterns()).toContain("**/*.fixture");
    expect(registry.getFilePreprocessors().map((p) => p.name)).toContain(
      "fixture-valid-plugin",
    );
  });

  it("calls a sync factory default export and registers the plugin it returns", async () => {
    const config = normalizeConfig({ plugins: ["@eventra_dev/cli-plugin-fixture-factory"] });

    const registry = await createPluginRegistry(config);

    expect(registry.getFilePreprocessors().map((p) => p.name)).toContain(
      "fixture-factory-plugin",
    );
  });

  it("awaits an async factory default export and registers the plugin it resolves to", async () => {
    const config = normalizeConfig({
      plugins: ["@eventra_dev/cli-plugin-fixture-async-factory"],
    });

    const registry = await createPluginRegistry(config);

    expect(registry.getFilePreprocessors().map((p) => p.name)).toContain(
      "fixture-async-factory-plugin",
    );
  });

  it("falls back to the module object itself when there is no default export", async () => {
    const config = normalizeConfig({
      plugins: ["@eventra_dev/cli-plugin-fixture-no-default"],
    });

    const registry = await createPluginRegistry(config);

    expect(registry.getFilePreprocessors().map((p) => p.name)).toContain(
      "fixture-no-default-plugin",
    );
  });

  it("throws a descriptive error when a trusted specifier's export isn't a valid CLI plugin", async () => {
    const config = normalizeConfig({
      plugins: ["@eventra_dev/cli-plugin-fixture-invalid-shape"],
    });

    await expect(createPluginRegistry(config)).rejects.toThrow(
      /Plugin "@eventra_dev\/cli-plugin-fixture-invalid-shape" must export a CLI plugin/,
    );
  });

  it("wraps an import() failure in a descriptive error instead of letting the raw error escape", async () => {
    const config = normalizeConfig({
      plugins: ["@eventra_dev/cli-plugin-fixture-import-throws"],
    });

    await expect(createPluginRegistry(config)).rejects.toThrow(
      /Failed to load plugin "@eventra_dev\/cli-plugin-fixture-import-throws"/,
    );
  });

  it("tolerates a config with no plugins field at all (bypassing normalizeConfig's default [])", async () => {
    // normalizeConfig always fills in `plugins: []`, so exercise the `config.plugins ?? []`
    // fallback directly with a hand-built config that omits the field, as a caller of
    // createPluginRegistry that skips normalizeConfig would.
    const config: EventraConfig = {
      apiKey: "",
      endpoint: "",
      events: [],
      functionWrappers: [],
      sync: { include: [], exclude: [] },
    };

    const registry = await createPluginRegistry(config);

    expect(registry.getSinkDetectors().map((d) => d.name)).toContain("eventra-sdk");
  });
});
