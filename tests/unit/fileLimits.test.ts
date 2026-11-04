import { describe, expect, it } from "vitest";

import { MAX_FILE_CHARS, OVERSIZED_REASON, fileLimit, isOversized, oversizedReason } from "../../src/core/fileLimits";
import { normalizeConfig } from "../../src/config/config";

describe("fileLimit", () => {
  it("takes a positive whole number, and anything else is the default", () => {
    expect(fileLimit(5000)).toBe(5000);
    expect(fileLimit(1)).toBe(1);
    for (const bad of [undefined, null, 0, -1, 1.5, NaN, Infinity, "5000", {}, [], true]) {
      expect(fileLimit(bad)).toBe(MAX_FILE_CHARS);
    }
  });
});

describe("isOversized", () => {
  it("is over the limit only above it, the default limit included", () => {
    expect(isOversized("a".repeat(10), 10)).toBe(false);
    expect(isOversized("a".repeat(11), 10)).toBe(true);
    expect(isOversized("a".repeat(MAX_FILE_CHARS))).toBe(false);
    expect(isOversized("a".repeat(MAX_FILE_CHARS + 1))).toBe(true);
  });
});

describe("oversizedReason", () => {
  it("names the limit only when the project changed it", () => {
    expect(oversizedReason()).toBe(OVERSIZED_REASON);
    expect(oversizedReason(MAX_FILE_CHARS)).toBe("file is larger than 2 MB");
    expect(oversizedReason(500)).toBe("file is larger than 500 characters (sync.maxFileSize)");
  });
});

describe("normalizeConfig: sync.maxFileSize", () => {
  const sync = (maxFileSize?: unknown) => normalizeConfig({ sync: { include: ["a"], exclude: [], maxFileSize: maxFileSize as number } }).sync;

  it("keeps a usable value that differs from the default", () => {
    expect(sync(5000).maxFileSize).toBe(5000);
  });

  it("leaves the key out when it would change nothing", () => {
    expect("maxFileSize" in sync()).toBe(false);
    expect("maxFileSize" in sync(MAX_FILE_CHARS)).toBe(false);
    expect("maxFileSize" in sync("big")).toBe(false);
    expect("maxFileSize" in sync(-5)).toBe(false);
  });
});
