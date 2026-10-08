import { describe, expect, it } from "vitest";

import { detectSinkPresets, PRESET_PACKAGES, SINK_PRESETS } from "../../src/plugin/builtins/sinkPresets";

const deps = (...names: string[]) => new Set(names);

describe("detectSinkPresets", () => {
  it("returns nothing for a project without analytics", () => {
    expect(detectSinkPresets(deps("react", "next", "typescript"))).toEqual([]);
    expect(detectSinkPresets(deps())).toEqual([]);
  });

  it.each([
    ["posthog", "posthog-js"],
    ["posthog", "@posthog/react"],
    ["posthog", "posthog-node"],
    ["posthog", "posthog-react-native"],
    ["posthog", "posthog-js-lite"],
    ["segment", "@segment/analytics-next"],
    ["segment", "@segment/analytics-node"],
    ["segment", "@segment/analytics-react-native"],
    ["segment", "@segment/snippet"],
    ["segment", "analytics-node"],
    ["segment", "@segment/analytics.js-core"],
    ["amplitude", "@amplitude/analytics-browser"],
    ["amplitude", "@amplitude/analytics-node"],
    ["amplitude", "@amplitude/analytics-react-native"],
    ["amplitude", "@amplitude/unified"],
    ["amplitude", "@amplitude/marketing-analytics-browser"],
    ["amplitude", "amplitude-js"],
    ["ga4", "react-ga4"],
    ["ga4", "vue-gtag"],
    ["ga4", "vue-gtag-next"],
    ["ga4", "@next/third-parties"],
    ["ga4", "nuxt-gtag"],
    ["ga4", "@types/gtag.js"],
  ])("recognises %s from %s", (preset, name) => {
    expect(detectSinkPresets(deps(name))).toEqual([{ preset, packages: [name] }]);
  });

  it("lists every matching package and keeps preset order", () => {
    const result = detectSinkPresets(deps("react-ga4", "posthog-node", "posthog-js", "@amplitude/analytics-browser", "@segment/analytics-next"));
    expect(result).toEqual([
      { preset: "posthog", packages: ["posthog-js", "posthog-node"] },
      { preset: "segment", packages: ["@segment/analytics-next"] },
      { preset: "amplitude", packages: ["@amplitude/analytics-browser"] },
      { preset: "ga4", packages: ["react-ga4"] },
    ]);
  });

  it("does not match similarly named packages", () => {
    expect(detectSinkPresets(deps("posthog", "posthog-js-fake", "react-ga", "analytics", "amplitude", "@posthog/nextjs", "segment"))).toEqual([]);
  });
});

describe("preset tables", () => {
  it("has a package list for exactly the presets that have rules", () => {
    expect(Object.keys(PRESET_PACKAGES)).toEqual(Object.keys(SINK_PRESETS));
  });

  it("never lists a package twice, and names are valid npm names", () => {
    const all = Object.values(PRESET_PACKAGES).flat().map((p) => p.name);
    expect(new Set(all).size).toBe(all.length);
    for (const name of all) expect(name).toMatch(/^(@[a-z0-9][a-z0-9.-]*\/)?[a-z0-9][a-z0-9._-]*$/);
  });

  it("only vets receivers against packages of the same preset, never against detect-only signals", () => {
    for (const [preset, rules] of Object.entries(SINK_PRESETS)) {
      const vettable = PRESET_PACKAGES[preset].filter((p) => !p.detectOnly).map((p) => p.name);
      const detectOnly = PRESET_PACKAGES[preset].filter((p) => p.detectOnly).map((p) => p.name);
      for (const rule of rules) {
        for (const module of rule.modules ?? []) {
          expect(vettable, `${preset}: ${module}`).toContain(module);
          expect(detectOnly).not.toContain(module);
        }
      }
    }
  });

  it("gives every preset at least one rule that works without any package (globals and CDN snippets)", () => {
    for (const [preset, rules] of Object.entries(SINK_PRESETS)) {
      expect(rules.some((r) => r.modules === undefined), preset).toBe(true);
    }
  });

  it("marks only genuinely old packages as legacy", () => {
    const legacy = Object.values(PRESET_PACKAGES).flat().filter((p) => p.legacy).map((p) => p.name).sort();
    expect(legacy).toEqual(["@segment/analytics.js-core", "amplitude-js", "analytics-node", "vue-gtag-next"]);
  });

  it("lists exactly which packages are only signals, per preset", () => {
    const detectOnly = Object.fromEntries(
      Object.entries(PRESET_PACKAGES).map(([preset, pkgs]) => [preset, pkgs.filter((p) => p.detectOnly).map((p) => p.name)]),
    );
    expect(detectOnly).toEqual({
      posthog: [],
      segment: ["@segment/snippet"],
      amplitude: [],
      ga4: ["@next/third-parties", "nuxt-gtag", "@types/gtag.js"],
    });
  });

  it("vets each rule against exactly these packages", () => {
    const modulesByRule = Object.fromEntries(
      Object.entries(SINK_PRESETS).map(([preset, rules]) => [
        preset,
        rules.filter((r) => r.modules).map((r) => `${r.callee}: ${r.modules!.join(", ")}`),
      ]),
    );
    expect(modulesByRule).toEqual({
      posthog: ["capture: posthog-js, @posthog/react, posthog-js-lite, posthog-node, posthog-react-native"],
      segment: [
        "track: @segment/analytics-next, @segment/analytics-node, @segment/analytics-react-native, @segment/analytics.js-core, analytics-node",
      ],
      amplitude: [
        "track: @amplitude/analytics-browser, @amplitude/analytics-node, @amplitude/analytics-react-native, @amplitude/marketing-analytics-browser, @amplitude/unified, amplitude-js",
        "logEvent: @amplitude/analytics-browser, @amplitude/analytics-node, @amplitude/analytics-react-native, @amplitude/marketing-analytics-browser, @amplitude/unified, amplitude-js",
      ],
      ga4: ["event: vue-gtag, vue-gtag-next", "event: react-ga4"],
    });
  });

  it("keeps the rules that need no package, exactly", () => {
    const plain = Object.fromEntries(
      Object.entries(SINK_PRESETS).map(([preset, rules]) => [preset, rules.filter((r) => !r.modules).map((r) => r.callee)]),
    );
    expect(plain).toEqual({
      posthog: ["posthog.capture"],
      segment: ["analytics.track"],
      amplitude: ["amplitude.track", "amplitude.logEvent"],
      ga4: ["gtag", "sendGAEvent", "useTrackEvent", "$gtag.event"],
    });
  });
});
