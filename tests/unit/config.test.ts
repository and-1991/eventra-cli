import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../../src/config/config";

describe("normalizeConfig", () => {
  it("fills defaults for an empty input", () => {
    const out = normalizeConfig({});
    expect(out.apiKey).toBe("");
    expect(out.endpoint).toBe("");
    expect(out.events).toEqual([]);
    expect(out.functionWrappers).toEqual([]);
    expect(out.sync.include).toEqual(["**/*.{ts,tsx,js,jsx}"]);
    expect(out.sync.exclude).toEqual(["node_modules", "dist", ".next", ".git"]);
  });

  it("sorts events alphabetically", () => {
    const out = normalizeConfig({
      events: ["c", "a", "b"],
    });
    expect(out.events).toEqual(["a", "b", "c"]);
  });

  it("dedupes function wrappers by name and drops empty entries", () => {
    const out = normalizeConfig({
      functionWrappers: [
        { name: "trackFeature" },
        { name: "" },
        { name: "trackFeature" },
        { name: "anotherWrapper" },
      ],
    });
    expect(out.functionWrappers.map((w) => w.name)).toEqual([
      "anotherWrapper",
      "trackFeature",
    ]);
  });

  it("strips extra fields from wrappers and keeps only { name }", () => {
    const out = normalizeConfig({
      functionWrappers: [
        // @ts-expect-error — testing extra fields
        { name: "trackFeature", legacy: true, file: "/path/old.ts" },
      ],
    });
    expect(Object.keys(out.functionWrappers[0])).toEqual(["name"]);
  });

  it("preserves provided apiKey, endpoint, include, and exclude", () => {
    const out = normalizeConfig({
      apiKey: "k",
      endpoint: "https://api.example.com",
      sync: {
        include: ["src/**/*.ts"],
        exclude: ["build"],
      },
    });
    expect(out.apiKey).toBe("k");
    expect(out.endpoint).toBe("https://api.example.com");
    expect(out.sync.include).toEqual(["src/**/*.ts"]);
    expect(out.sync.exclude).toEqual(["build"]);
  });
});
