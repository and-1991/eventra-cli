import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeConfigProblem, normalizeConfig } from "../../src/config/config";
import { listFiles } from "../../src/core/listFiles";
import { scanProject } from "../../src/core/projectScanner";
import { excludeGlobs } from "../../src/core/scanFilters";
import { cleanSkipReason, describeProblems, reportPartial, skippedFrom } from "../../src/core/skipped";
import { MAX_AST_DEPTH, TOO_DEEP_REASON, astDepth, isStackOverflow } from "../../src/filesystem/processFile";
import { describeFetchError } from "../../src/cli/send";

const parse = (code: string) => ts.createSourceFile("a.ts", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

describe("depth: which chains are flat", () => {
  const chain = (operator: string, n: number) => `const x = ${Array.from({ length: n }, () => "a").join(` ${operator} `)};`;

  it("arithmetic, bitwise and comparison chains are walked in a loop by the compiler: not counted", () => {
    for (const operator of ["+", "-", "*", "|", "&", "==", "==="]) expect(astDepth(parse(chain(operator, 3000)))).toBeLessThan(MAX_AST_DEPTH);
  });

  it("&&, || and ?? chains overflow the binder at about 800 operands: counted", () => {
    for (const operator of ["&&", "||", "??"]) expect(astDepth(parse(chain(operator, 900)))).toBeGreaterThan(MAX_AST_DEPTH);
  });

  it("the limit is 500", () => {
    expect(MAX_AST_DEPTH).toBe(500);
  });
});

describe("a call stack that ran out while reading", () => {
  it("is shown as the code nesting too deeply, not as the raw message", () => {
    const overflow = new RangeError("Maximum call stack size exceeded");
    expect(isStackOverflow(overflow)).toBe(true);
    expect(isStackOverflow(new RangeError("Invalid array length"))).toBe(false);
    expect(isStackOverflow(new Error("Maximum call stack size exceeded"))).toBe(false);
    expect(skippedFrom("/p/a.ts", overflow)).toEqual({ file: "/p/a.ts", reason: TOO_DEEP_REASON });
    expect(skippedFrom("/p/a.ts", new Error("boom")).reason).toBe("boom");
  });

  it("an unreadable file is not reported as `open ''`", () => {
    expect(cleanSkipReason("/p/a.ts", "EACCES: permission denied, open '/p/a.ts'")).toBe("EACCES: permission denied");
    expect(cleanSkipReason("/p/a.ts", "EISDIR: illegal operation on a directory, read")).toBe("EISDIR: illegal operation on a directory, read");
  });
});

describe("sync.exclude: ./dist is the folder at the root", () => {
  it("./dist and /dist are the same, dist is any depth", () => {
    expect(excludeGlobs("./dist")).toEqual(["dist", "dist/**"]);
    expect(excludeGlobs("./dist/")).toEqual(["dist", "dist/**"]);
    expect(excludeGlobs("/dist")).toEqual(["dist", "dist/**"]);
    expect(excludeGlobs("dist")).toEqual(["**/dist", "**/dist/**"]);
    expect(excludeGlobs("./")).toEqual([]);
  });
});

describe("symbolic links", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-links-"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a link to a file is a file, a link to a folder is not followed, a link to nothing is nothing", async () => {
    fs.mkdirSync(path.join(root, "real"));
    fs.writeFileSync(path.join(root, "real", "a.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(root, "b.ts"), "export const b = 1;");
    fs.symlinkSync(path.join(root, "b.ts"), path.join(root, "link.ts"));
    fs.symlinkSync("real", path.join(root, "linkdir"));
    fs.symlinkSync("missing.ts", path.join(root, "broken.ts"));
    fs.mkdirSync(path.join(root, "folder.ts"));
    const found = (await listFiles(["**/*.ts"], [])).map((f) => path.relative(root, f)).sort();
    expect(found).toEqual(["b.ts", "link.ts", "real/a.ts"]);
  });
});

describe("a plugin's partial list", () => {
  it("counts files, not reasons", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      reportPartial([{ file: "/p/a.astro", reason: "one" }, { file: "/p/a.astro", reason: "two" }]);
      expect(String(error.mock.calls[0][0])).toContain("1 file was read only in part");
      const phrases = describeProblems({ skipped: [], ignored: [], syntaxErrors: [], rejected: [], dynamic: [], partial: [{ file: "/p/a.astro", reason: "one" }, { file: "/p/a.astro", reason: "two" }] });
      expect(phrases).toEqual(["1 file read only in part"]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("config: more values of the wrong type", () => {
  const warnings = (config: unknown): string[] => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      normalizeConfig(config as never);
      return warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }
  };

  it("entries of sync.include and sync.exclude that are not text", () => {
    expect(warnings({ sync: { include: ["src/**/*.ts", 5, null], exclude: [{ a: 1 }] } }).join("\n")).toMatch(/sync\.include/);
    expect(warnings({ sync: { include: ["a"], exclude: [{ a: 1 }, 2] } }).join("\n")).toMatch(/2 entries of "sync\.exclude"/);
  });

  it("apiKey and endpoint that are not text are left out, with a warning", () => {
    expect(warnings({ apiKey: 5 }).join("\n")).toContain('"apiKey"');
    expect(warnings({ endpoint: 7 }).join("\n")).toContain('"endpoint"');
    const out = normalizeConfig({ apiKey: 5, endpoint: { a: 1 } } as never);
    expect(out.apiKey).toBe("");
    expect(out.endpoint).toBe("");
  });

  it("the count reads as English", () => {
    expect(warnings({ events: ["a", 1, 2, 3] }).join("\n")).toMatch(/3 entries of "events".*are not a string/);
    expect(warnings({ events: ["b", 1] }).join("\n")).toMatch(/1 entry of "events".*is not a string/);
  });
});

describe("a config file that cannot be read", () => {
  const original = process.cwd();
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-cfgread-"));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(original);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is not called bad JSON when it is a folder; bad JSON still is", async () => {
    fs.mkdirSync(path.join(tmp, "eventra.json"));
    expect(await describeConfigProblem()).toMatch(/could not be read: .*EISDIR/);
    fs.rmSync(path.join(tmp, "eventra.json"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "eventra.json"), "{ nope");
    expect(await describeConfigProblem()).toMatch(/is not valid JSON/);
  });
});

describe("send: what fetch says", () => {
  it("fetch failed gets its reason from the cause", () => {
    const error = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(describeFetchError(error)).toBe("fetch failed (ECONNREFUSED)");
    expect(describeFetchError(Object.assign(new TypeError("fetch failed"), { cause: { message: "self-signed certificate" } }))).toBe("fetch failed (self-signed certificate)");
    expect(describeFetchError(Object.assign(new Error("connect ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } }))).toBe("connect ECONNREFUSED");
    expect(describeFetchError(new Error("plain"))).toBe("plain");
  });
});

describe("scanProject: a file that overflows while being parsed", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-r3-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("a long && chain is skipped with the reason and the rest is scanned", async () => {
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "ok.ts"), `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst t = new Eventra({ apiKey: "k" });\nt.track("fine.event");\n`);
    fs.writeFileSync(path.join(cwd, "src", "and.ts"), `declare const a: boolean;\nexport const x = ${Array.from({ length: 1200 }, () => "a").join(" && ")};\n`);
    const { engine, skipped } = await scanProject(normalizeConfig({ sync: { include: ["**/*.ts"], exclude: [] } }));
    expect(engine.getAllEvents()).toEqual(["fine.event"]);
    expect(skipped.map((s) => [path.relative(cwd, s.file), s.reason])).toEqual([["src/and.ts", TOO_DEEP_REASON]]);
  });
});

describe("Angular inputs", () => {
  const CODE = (body: string) => `import { Eventra } from "@eventra_dev/eventra-sdk";\ndeclare const Input: any; declare function input<T>(): any;\nconst t = new Eventra({ apiKey: "k" });\nexport class C {\n${body}\n}\n`;
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-ng-input-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const scan = async (body: string) => {
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "c.ts"), CODE(body));
    const result = await scanProject(normalizeConfig({ sync: { include: ["**/*.ts"], exclude: [] } }));
    return { events: result.engine.getAllEvents(), rejected: result.engine.getAllRejectedNames(), dynamic: result.engine.getAllDynamicOccurrences() };
  };

  it("a default that the parent overrides is not an event name: no 'empty' rejection for @Input() name = ''", async () => {
    const { events, rejected } = await scan(`  @Input() name = '';\n  go() { t.track(this.name); }`);
    expect(rejected).toEqual([]);
    expect(events).toEqual([]);
  });

  it("an input forwarded to track is a wrapper's call, not an unknown name (decorator, setter, signal)", async () => {
    for (const body of [`  @Input() name!: string;\n  go() { t.track(this.name); }`, `  @Input({ required: true }) name!: string;\n  go() { t.track(this.name); }`, `  private v = "";\n  @Input() set name(v: string) { this.v = v; }\n  get name(): string { return this.v; }\n  go() { t.track(this.name); }`, `  name = input<string>();\n  go() { t.track(this.name()); }`]) {
      const { dynamic } = await scan(body);
      expect({ body, kinds: dynamic.map((occurrence) => occurrence.kind) }).toEqual({ body, kinds: ["wrapper"] });
      fs.rmSync(path.join(cwd, "src"), { recursive: true });
    }
  });

  it("an ordinary field that is not an input is still resolved from what it is set to", async () => {
    const { events } = await scan(`  plain = "from.field";\n  go() { t.track(this.plain); }`);
    expect(events).toEqual(["from.field"]);
  });

  it("a field that is not an input and is not known stays an unknown name", async () => {
    const { dynamic } = await scan(`  plain = Math.random() > 0.5 ? "a" : String(Date.now());\n  go() { t.track(this.plain); }`);
    expect(dynamic.length).toBe(1);
    expect(dynamic[0].kind).not.toBe("wrapper");
  });
});
