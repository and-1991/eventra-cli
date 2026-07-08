import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginRegistry, isTrustedPluginSpecifier } from "../../src/plugin/loadPlugins";
import { normalizeConfig } from "../../src/config/config";

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
});
