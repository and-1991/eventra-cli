import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanSkipReason,
  describeProblems,
  errorMessage,
  formatIgnored,
  formatPluginNotes,
  formatRejectedNames,
  formatSkipped,
  formatSyntaxErrors,
  hasStrictProblems,
  printable,
  plural,
  reportIgnored,
  reportPluginNotes,
  reportRejectedNames,
  reportSkipped,
  reportSyntaxErrors,
  skippedFrom,
  type ScanProblems,
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

const rejected = (over: Record<string, unknown> = {}) => ({
  fileName: "/p/src/a.ts",
  line: 4,
  character: 2,
  calleeText: "sdk.track",
  callText: "sdk.track(...)",
  resolvedValues: ["x"],
  name: "bad name!",
  reason: "the name has characters other than letters",
  ...over,
}) as never;

describe("formatSyntaxErrors / reportSyntaxErrors", () => {
  it("lists each file with its error, worded as a heads-up", () => {
    expect(formatSyntaxErrors([], "/p")).toEqual([]);
    expect(
      formatSyntaxErrors([{ file: "/p/src/a.ts", reason: "line 3: ';' expected." }], "/p"),
    ).toEqual(["Syntax errors in 1 file (events after the error may be missed):", "  src/a.ts: line 3: ';' expected."]);
    expect(
      formatSyntaxErrors([{ file: "/p/a.ts", reason: "x" }, { file: "/p/b.ts", reason: "y" }], "/p")[0],
    ).toBe("Syntax errors in 2 files (events after the error may be missed):");
  });

  it("writes one note to stderr, or nothing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    reportSyntaxErrors([], "/p");
    expect(err).not.toHaveBeenCalled();
    reportSyntaxErrors([{ file: "/p/a.ts", reason: "line 1: boom" }], "/p");
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe("formatRejectedNames / reportRejectedNames", () => {
  it("names the file and line, or the template, with the reason", () => {
    expect(formatRejectedNames([], "/p")).toEqual([]);
    expect(formatRejectedNames([rejected()], "/p")).toEqual([
      "Skipped 1 event name the CLI cannot accept:",
      '  src/a.ts:4 "bad name!": the name has characters other than letters',
    ]);
    const lines = formatRejectedNames(
      [
        rejected({ fileName: "/p/src/A.vue", inTemplate: true, name: "tpl" }),
        rejected({ fileName: "/p/src/B.vue", inTemplateCode: true, name: "code" }),
        rejected({ fileName: "/p/src/c.html", inGeneratedCode: true, name: "copy" }),
      ],
      "/p",
    );
    expect(lines[0]).toBe("Skipped 2 event names the CLI cannot accept:");
    expect(lines[1]).toBe('  template of src/A.vue "tpl": the name has characters other than letters');
    expect(lines[2]).toBe('  template of src/B.vue "code": the name has characters other than letters');
    expect(lines).toHaveLength(3);
  });

  it("writes the list and the rule to stderr, or nothing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    reportRejectedNames([], "/p");
    expect(err).not.toHaveBeenCalled();
    reportRejectedNames([rejected()], "/p");
    expect(err).toHaveBeenCalledTimes(2);
    expect(String(err.mock.calls[1][0])).toContain("letters of any language");
    err.mockRestore();
  });
});

describe("describeProblems and hasStrictProblems", () => {
  const file = { file: "/p/a.ts", reason: "r" };
  const rejectedName = (extra: Record<string, unknown> = {}) => ({ fileName: "/p/a.ts", line: 1, character: 0, calleeText: "t", callText: "", resolvedValues: [], name: "x", reason: "r", ...extra });
  const occurrence = (resolvedValues: string[], extra: Record<string, unknown> = {}) => ({ fileName: "/p/a.ts", line: 1, character: 0, calleeText: "t", callText: "", resolvedValues, ...extra });
  const clean: ScanProblems = { skipped: [], ignored: [], syntaxErrors: [], rejected: [], dynamic: [] };

  it("is empty and not strict for a clean scan", () => {
    expect(describeProblems(clean)).toEqual([]);
    expect(hasStrictProblems(clean)).toBe(false);
  });

  it("has one phrase per kind, singular for one and plural for more, in the order they are reported", () => {
    expect(
      describeProblems({ skipped: [file], syntaxErrors: [file], rejected: [rejectedName()], dynamic: [occurrence([])], ignored: [file] }),
    ).toEqual(["1 skipped file", "1 file with a syntax error", "1 event name the CLI cannot accept", "1 dynamic event name", "1 file over the size limit"]);
    expect(
      describeProblems({ skipped: [file, file], syntaxErrors: [file, file], rejected: [rejectedName(), rejectedName()], dynamic: [occurrence([]), occurrence([])], ignored: [file, file] }),
    ).toEqual(["2 skipped files", "2 files with syntax errors", "2 event names the CLI cannot accept", "2 dynamic event names", "2 files over the size limit"]);
  });

  it("does not count a call inside a wrapper, but counts an unresolved one", () => {
    const wrapper = { ...occurrence([]), kind: "wrapper" };
    const unknown = { ...occurrence([]), kind: "unresolved", cause: "env" };
    expect(describeProblems({ ...clean, dynamic: [wrapper] })).toEqual([]);
    expect(hasStrictProblems({ ...clean, dynamic: [wrapper] })).toBe(false);
    expect(describeProblems({ ...clean, dynamic: [wrapper, unknown] })).toEqual(["1 dynamic event name"]);
    expect(hasStrictProblems({ ...clean, dynamic: [wrapper, unknown] })).toBe(true);
  });

  it("does not count a generated copy of a call, or a dynamic name that has resolved values", () => {
    const problems = { ...clean, rejected: [rejectedName({ inGeneratedCode: true })], dynamic: [occurrence([], { inGeneratedCode: true }), occurrence(["a"])] };
    expect(describeProblems(problems)).toEqual([]);
    expect(hasStrictProblems(problems)).toBe(false);
  });

  it("fails --strict on each of skipped, syntax errors, rejected names, unresolved dynamic names and ignored files", () => {
    expect(hasStrictProblems({ ...clean, skipped: [file] })).toBe(true);
    expect(hasStrictProblems({ ...clean, syntaxErrors: [file] })).toBe(true);
    expect(hasStrictProblems({ ...clean, rejected: [rejectedName()] })).toBe(true);
    expect(hasStrictProblems({ ...clean, dynamic: [occurrence([])] })).toBe(true);
    expect(hasStrictProblems({ ...clean, ignored: [file] })).toBe(true);
  });

  it("declared dynamic events acknowledge the dynamic names, and only those", () => {
    const problems = { ...clean, dynamic: [occurrence([])], dynamicDeclared: true };
    expect(describeProblems(problems)).toEqual([]);
    expect(hasStrictProblems(problems)).toBe(false);
    expect(hasStrictProblems({ ...problems, skipped: [file] })).toBe(true);
  });
});

describe("printable", () => {
  it("leaves ordinary text, other languages and punctuation alone", () => {
    expect(printable("App: User Sign Up")).toBe("App: User Sign Up");
    expect(printable("Заказ оформлен [v2] & co's")).toBe("Заказ оформлен [v2] & co's");
  });

  it("shows control characters, escape sequences and invisible text as visible escapes", () => {
    expect(printable("a\nb\rc\td")).toBe("a\\nb\\rc\\td");
    // an escape sequence that would recolour or rewrite the terminal
    expect(printable("x\u001b[31mred\u001b[0m")).toBe("x\\x1b[31mred\\x1b[0m");
    expect(printable("a\u0000b\u007fc\u009bd")).toBe("a\\x00b\\x7fc\\x9bd");
    // text that is reordered or hidden: a right-to-left override, a zero-width space, a line separator, a BOM
    expect(printable("a\u202eb\u200bc\u2028d\ufeffe")).toBe("a\\u202eb\\u200bc\\u2028d\\ufeffe");
  });

  it("is applied to a rejected name, so an escape sequence in code is not run by the terminal", () => {
    const lines = formatRejectedNames([{ ...rejected(), name: "evil\u001b]0;pwned\u0007" }], "/p");
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).not.toContain("\u0007");
    expect(lines.join("\n")).toContain("evil\\x1b]0;pwned\\x07");
  });
});

describe("plugin notes", () => {
  it("lists each file with what the plugin said, singular for one file", () => {
    expect(formatPluginNotes([], "/p")).toEqual([]);
    expect(formatPluginNotes([{ file: "/p/a.html", reason: "r1" }], "/p")).toEqual(["Notes from plugins on 1 file:", "  a.html: r1"]);
    expect(formatPluginNotes([{ file: "/p/a.html", reason: "r1" }, { file: "/p/b.html", reason: "r2" }], "/p")).toEqual(["Notes from plugins on 2 files:", "  a.html: r1", "  b.html: r2"]);
  });

  it("writes the list to stderr, or nothing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    reportPluginNotes([], "/p");
    expect(err).not.toHaveBeenCalled();
    reportPluginNotes([{ file: "/p/a.html", reason: "r1" }], "/p");
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
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
