import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanSkipReason,
  errorMessage,
  formatIgnored,
  formatSkipped,
  plural,
  reportIgnored,
  reportSkipped,
  skippedFrom,
} from "../../src/core/skipped";

const FILE = "/home/u/my project/src/Bad.vue";

describe("cleanSkipReason", () => {
  it("strips the wrapper chain that repeats the path three times", () => {
    const message = `Plugin "vue" failed to transform ${FILE}: Failed to parse Vue SFC ${FILE}: Element is missing end tag.`;
    expect(cleanSkipReason(FILE, message)).toBe("Element is missing end tag.");
  });

  it("handles the Svelte and Astro wording", () => {
    expect(
      cleanSkipReason(FILE, `Plugin "svelte" failed to transform ${FILE}: Failed to parse Svelte SFC ${FILE}: boom`),
    ).toBe("boom");
    expect(
      cleanSkipReason(FILE, `Plugin "astro" failed to transform ${FILE}: Failed to parse Astro component ${FILE}: bad`),
    ).toBe("bad");
  });

  it("keeps ordinary messages and collapses whitespace", () => {
    expect(cleanSkipReason(FILE, `ENOENT: no such file\n  '${FILE}'`)).toBe("ENOENT: no such file ''");
  });

  it("never returns an empty reason", () => {
    expect(cleanSkipReason(FILE, FILE)).toBe("unknown error");
  });
});

describe("skippedFrom / errorMessage", () => {
  it("accepts Error objects and plain values", () => {
    expect(errorMessage(new Error("x"))).toBe("x");
    expect(errorMessage("plain")).toBe("plain");
    expect(skippedFrom(FILE, new Error(`Failed to parse Vue SFC ${FILE}: nope`))).toEqual({
      file: FILE,
      reason: "nope",
    });
  });
});

describe("formatSkipped / reportSkipped", () => {
  const skipped = [
    { file: "/p/src/a.vue", reason: "bad a" },
    { file: "/p/src/b.svelte", reason: "file is larger than 2 MB" },
  ];

  it("prints nothing when nothing was skipped", () => {
    expect(formatSkipped([], "/p")).toEqual([]);
  });

  it("lists each file once, relative to the project, under one header", () => {
    expect(formatSkipped(skipped, "/p")).toEqual([
      "Skipped 2 files that could not be analysed:",
      "  src/a.vue: bad a",
      "  src/b.svelte: file is larger than 2 MB",
    ]);
    expect(formatSkipped([skipped[0]], "/p")[0]).toBe("Skipped 1 file that could not be analysed:");
  });

  describe("reportSkipped", () => {
    afterEach(() => vi.restoreAllMocks());

    it("writes one summary to stderr", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      reportSkipped(skipped, "/p");
      expect(err).toHaveBeenCalledTimes(2);
      expect(String(err.mock.calls[0][0])).toContain("src/a.vue: bad a");
    });

    it("stays silent for an empty list", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      reportSkipped([], "/p");
      expect(err).not.toHaveBeenCalled();
    });
  });
});

describe("formatIgnored / reportIgnored", () => {
  const ignored = [{ file: "/p/dist/vendor.min.js", reason: "file is larger than 2 MB" }];

  afterEach(() => vi.restoreAllMocks());

  it("is not worded as a failure", () => {
    expect(formatIgnored([], "/p")).toEqual([]);
    expect(formatIgnored(ignored, "/p")).toEqual([
      "Ignored 1 file (not analysed):",
      "  dist/vendor.min.js: file is larger than 2 MB",
    ]);
    expect(formatIgnored([...ignored, ...ignored], "/p")[0]).toBe("Ignored 2 files (not analysed):");
  });

  it("writes one note to stderr, or nothing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    reportIgnored([], "/p");
    expect(err).not.toHaveBeenCalled();
    reportIgnored(ignored, "/p");
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("vendor.min.js");
  });

  it("defaults to the working directory", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    reportIgnored([{ file: path.join(process.cwd(), "big.js"), reason: "file is larger than 2 MB" }]);
    expect(String(err.mock.calls[0][0])).toContain("  big.js:");
  });
});

describe("plural", () => {
  it("uses the singular for exactly one", () => {
    expect(plural(1, "event")).toBe("1 event");
    expect(plural(0, "event")).toBe("0 events");
    expect(plural(2, "function wrapper")).toBe("2 function wrappers");
    expect(plural(1, "known entry", "known entries")).toBe("1 known entry");
    expect(plural(3, "known entry", "known entries")).toBe("3 known entries");
  });
});
