import { describe, expect, it } from "vitest";

import { exitCodeFor, judgePackage, STALE_AFTER_DAYS, type Packument } from "../../scripts/preset-packages-lib";

const NOW = new Date("2026-10-08T00:00:00Z");
const current: Packument = {
  "dist-tags": { latest: "2.0.0" },
  versions: { "2.0.0": {} },
  time: { "2.0.0": "2026-09-01T10:00:00.000Z" },
};

describe("judgePackage", () => {
  it("reports a package that is not in the registry as an error", () => {
    expect(judgePackage({ name: "gone" }, null, NOW)).toEqual({ name: "gone", level: "error", message: "not found in the npm registry" });
  });

  it("accepts a current package and reports its version and date", () => {
    expect(judgePackage({ name: "ok" }, current, NOW)).toEqual({
      name: "ok",
      level: "ok",
      latest: "2.0.0",
      published: "2026-09-01",
      message: "current",
    });
  });

  it("reports a deprecated latest version as an error unless the package is marked legacy", () => {
    const deprecated: Packument = { ...current, versions: { "2.0.0": { deprecated: "Use @scope/new instead" } } };
    const verdict = judgePackage({ name: "old" }, deprecated, NOW);
    expect(verdict.level).toBe("error");
    expect(verdict.message).toBe("latest version is deprecated: Use @scope/new instead");
    expect(judgePackage({ name: "old", legacy: true }, deprecated, NOW)).toMatchObject({ level: "info", message: "legacy, deprecated as expected" });
  });

  it("truncates a long deprecation notice", () => {
    const deprecated: Packument = { ...current, versions: { "2.0.0": { deprecated: "x".repeat(300) } } };
    expect(judgePackage({ name: "old" }, deprecated, NOW).message).toBe(`latest version is deprecated: ${"x".repeat(100)}`);
  });

  it("warns about a maintained package that has not been published for three years", () => {
    const stale: Packument = { ...current, time: { "2.0.0": "2022-06-01T00:00:00.000Z" } };
    expect(judgePackage({ name: "stale" }, stale, NOW)).toMatchObject({ level: "warn", message: "not published since 2022-06-01" });
    expect(judgePackage({ name: "stale", legacy: true }, stale, NOW)).toMatchObject({ level: "info", message: "legacy, not deprecated" });
  });

  it("uses a three year threshold, inclusive of exactly three years", () => {
    expect(STALE_AFTER_DAYS).toBe(1095);
    const boundary: Packument = { ...current, time: { "2.0.0": "2023-10-09T00:00:00.000Z" } };
    expect(judgePackage({ name: "edge" }, boundary, NOW).level).toBe("ok");
    const past: Packument = { ...current, time: { "2.0.0": "2023-10-07T00:00:00.000Z" } };
    expect(judgePackage({ name: "edge" }, past, NOW).level).toBe("warn");
  });

  it("copes with a latest version that has no entry in versions or time", () => {
    const sparse: Packument = { "dist-tags": { latest: "3.0.0" }, versions: {}, time: {} };
    expect(judgePackage({ name: "sparse" }, sparse, NOW)).toEqual({
      name: "sparse",
      level: "ok",
      latest: "3.0.0",
      published: undefined,
      message: "current",
    });
  });

  it("copes with a registry document that lacks dist-tags, versions or time", () => {
    expect(judgePackage({ name: "bare" }, {}, NOW)).toEqual({ name: "bare", level: "ok", latest: undefined, published: undefined, message: "current" });
    const noTime: Packument = { "dist-tags": { latest: "1.0.0" } };
    expect(judgePackage({ name: "bare" }, noTime, NOW)).toMatchObject({ level: "ok", latest: "1.0.0", published: undefined });
    expect(judgePackage({ name: "bare" }, { "dist-tags": {} }, NOW).level).toBe("ok");
  });
});

describe("exitCodeFor", () => {
  it("fails only when a package is missing or wrongly deprecated", () => {
    const ok = judgePackage({ name: "a" }, current, NOW);
    const warn = judgePackage({ name: "b" }, { ...current, time: { "2.0.0": "2020-01-01T00:00:00Z" } }, NOW);
    const error = judgePackage({ name: "c" }, null, NOW);
    expect(exitCodeFor([])).toBe(0);
    expect(exitCodeFor([ok, warn])).toBe(0);
    expect(exitCodeFor([ok, error])).toBe(1);
  });
});
