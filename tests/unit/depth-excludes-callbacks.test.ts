import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyDynamic } from "../../src/analysis/shared/dynamicCause";
import { normalizeConfig } from "../../src/config/config";
import { createFileFilter, excludeGlobs, expandExcludePatterns, withDefaultExcludes } from "../../src/core/scanFilters";
import { scanProject } from "../../src/core/projectScanner";
import { MAX_AST_DEPTH, TOO_DEEP_REASON, astDepth, isTooDeep, processFile } from "../../src/filesystem/processFile";

const parse = (code: string) => ts.createSourceFile("a.ts", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

describe("astDepth", () => {
  it("is the nesting of the tree, found without recursion", () => {
    expect(astDepth(parse("const a = 1;"))).toBeLessThan(10);
    const chain = `const x = ${"f().".repeat(3000)}g();`;
    expect(astDepth(parse(chain))).toBeGreaterThan(MAX_AST_DEPTH);
  });

  it("does not count a left-leaning chain of + as depth, but counts one of && (the binder recurses on it)", () => {
    expect(astDepth(parse(`const x = ${Array.from({ length: 5000 }, () => '"a"').join(" + ")};`))).toBeLessThan(MAX_AST_DEPTH);
    expect(astDepth(parse(`const x = ${Array.from({ length: 900 }, () => "a").join(" && ")};`))).toBeGreaterThan(MAX_AST_DEPTH);
  });

  it("counts nesting that is not a chain of binary operators", () => {
    // a member chain: the parser reads it in a loop, so building the tree cannot overflow in a worker with a small stack
    expect(astDepth(parse(`const x = a${".b".repeat(1500)};`))).toBeGreaterThan(MAX_AST_DEPTH);
  });

  it("isTooDeep and processFile agree, for TypeScript and JavaScript names", async () => {
    const chain = `export const x = ${"f().".repeat(3000)}g();`;
    expect(isTooDeep("a.ts", chain)).toBe(true);
    expect(isTooDeep("a.js", chain)).toBe(true);
    expect(isTooDeep("a.ts", "export const a = 1;")).toBe(false);
    expect((await processFile("a.ts", chain)).depth).toBeGreaterThan(MAX_AST_DEPTH);
    expect((await processFile("a.tsx", "export const a = <div/>;")).depth).toBeLessThan(MAX_AST_DEPTH);
  });
});

describe("scanProject: code that nests beyond what the binder can walk", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-deep-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content);
  };
  const SDK = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst t = new Eventra({ apiKey: "k" });\n`;
  const config = () => normalizeConfig({ sync: { include: ["**/*.ts"], exclude: [] } });

  it("lists the file as skipped, by name, and scans the rest (a chain of 3000 calls)", async () => {
    write("src/ok.ts", `${SDK}t.track("fine.event");\n`);
    write("src/deep.ts", `${SDK}const x = ${"f().".repeat(3000)}g();\nt.track("never.seen");\n`);
    const { engine, skipped } = await scanProject(config());
    expect(engine.getAllEvents()).toEqual(["fine.event"]);
    expect(skipped.map((s) => [path.relative(cwd, s.file), s.reason])).toEqual([["src/deep.ts", TOO_DEEP_REASON]]);
  });

  it("does not follow symbolic links, so two links back to the folder cannot make the walk endless", async () => {
    write("src/ok.ts", `${SDK}t.track("fine.event");\n`);
    fs.symlinkSync(".", path.join(cwd, "src", "l1"));
    fs.symlinkSync(".", path.join(cwd, "src", "l2"));
    const started = Date.now();
    const { engine } = await scanProject(config());
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(engine.getAllEvents()).toEqual(["fine.event"]);
  }, 30_000);

  it("never scans node_modules, even when sync.exclude does not list it", async () => {
    write("src/ok.ts", `${SDK}t.track("fine.event");\n`);
    write("node_modules/lib/a.ts", `${SDK}t.track("from.node.modules");\n`);
    const { engine, files } = await scanProject(config());
    expect(files.map((f) => path.relative(cwd, f))).toEqual(["src/ok.ts"]);
    expect(engine.getAllEvents()).toEqual(["fine.event"]);
  });
});

describe("sync.exclude entries", () => {
  it("dist and dist/ are the folder at any depth, /dist and ./dist the one at the root", () => {
    expect(excludeGlobs("dist")).toEqual(["**/dist", "**/dist/**"]);
    expect(excludeGlobs("dist/")).toEqual(["**/dist", "**/dist/**"]);
    expect(excludeGlobs("/dist")).toEqual(["dist", "dist/**"]);
    expect(excludeGlobs("./dist/")).toEqual(["dist", "dist/**"]);
    expect(excludeGlobs("packages/legacy/")).toEqual(["packages/legacy"]);
    expect(excludeGlobs("**/*.gen.ts")).toEqual(["**/*.gen.ts"]);
    expect(excludeGlobs("/src/**")).toEqual(["src/**"]);
    expect(excludeGlobs("  ")).toEqual([]);
    expect(excludeGlobs("/")).toEqual([]);
  });

  it("expand and filter agree", () => {
    expect(expandExcludePatterns(["dist/", "/build", "dist"])).toEqual(["**/dist", "**/dist/**", "build", "build/**"]);
    expect(withDefaultExcludes(["dist"])).toEqual(["node_modules", "dist"]);
    const filter = createFileFilter(["**/*.ts"], withDefaultExcludes(["dist/", "/build"]), "/p");
    expect(filter.isExcluded("/p/packages/a/dist/x.ts")).toBe(true);
    expect(filter.isExcluded("/p/build/x.ts")).toBe(true);
    expect(filter.isExcluded("/p/packages/a/build/x.ts")).toBe(false);
    expect(filter.isExcluded("/p/node_modules/x/y.ts")).toBe(true);
    expect(filter.isExcluded("/p/src/x.ts")).toBe(false);
  });
});

describe("classifyDynamic: parameters of callbacks", () => {
  const classify = (code: string) => {
    const file = "/virtual/c.ts";
    const host = ts.createCompilerHost({});
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, ...rest) => (name === file ? ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true) : original(name, ...rest));
    host.fileExists = (name) => name === file || ts.sys.fileExists(name);
    host.readFile = (name) => (name === file ? code : ts.sys.readFile(name));
    const program = ts.createProgram([file], { noLib: true, noResolve: true }, host);
    const checker = program.getTypeChecker();
    let found: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (!found && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "track") found = node.arguments[0];
      ts.forEachChild(node, visit);
    };
    visit(program.getSourceFile(file)!);
    return classifyDynamic(found!, checker);
  };

  it("a callback given to forEach, map, addEventListener, then: the values are not in the code", () => {
    for (const call of ['["a", "b"].forEach((n) => t.track(n))', 'items.map((i) => t.track(i.name))', 'el.addEventListener("click", (e) => t.track(e.type))', 'p.then(function (r) { t.track(r.id); })', "items.forEach(({ id }) => t.track(id))", "setTimeout((x) => t.track(x), 1)"]) {
      expect(classify(`declare const t: any, items: any, el: any, p: any;\n${call};`)).toEqual({ kind: "unresolved", cause: "callback" });
    }
  });

  it("a named function, a function that is not given to such a call, and a wrapper stay wrappers", () => {
    expect(classify("declare const t: any;\nfunction wrap(name: string) { t.track(name); }").kind).toBe("wrapper");
    expect(classify("declare const t: any;\nconst wrap = (name: string) => t.track(name);").kind).toBe("wrapper");
    expect(classify("declare const t: any, use: any;\nuse((name: string) => t.track(name));").kind).toBe("wrapper");
    expect(classify("declare const t: any, o: any;\no.other((name: string) => t.track(name));").kind).toBe("wrapper");
    expect(classify("declare const t: any, o: any;\no.map(function (this: any, name: string) { t.track(name); }, o);").cause).toBe("callback");
  });

  it("a name that is a parameter and also declared again with var stays a wrapper", () => {
    expect(classify("declare const t: any;\nfunction wrap(name: string) { var name: any; t.track(name); }").kind).toBe("wrapper");
  });

  it("a function given to a call whose callee is neither a name nor a member stays a wrapper", () => {
    expect(classify("declare const t: any, fns: any;\nfns[0]((name: string) => t.track(name));").kind).toBe("wrapper");
  });

  it("an arrow function that is an argument of something that is not a call stays a wrapper", () => {
    expect(classify("declare const t: any;\nconst o = { go: (name: string) => t.track(name) };").kind).toBe("wrapper");
  });
});

describe("normalizeConfig: values of the wrong type are said, not lost quietly", () => {
  const warnings = (config: unknown): string[] => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      normalizeConfig(config as never);
      return warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }
  };

  it("sinks that is not a list, and entries that are not rules", () => {
    expect(warnings({ sinks: { preset: "posthog" } }).join("\n")).toContain('"sinks"');
    expect(warnings({ sinks: [{ preset: "posthog" }, 5, "x"] }).join("\n")).toContain('"sinks"');
  });

  it("events that is a string or holds non-strings: not spread into characters", () => {
    expect(warnings({ events: "abc" }).join("\n")).toContain('"events"');
    expect(warnings({ events: ["z", 5, null, "a"] }).join("\n")).toContain('"events"');
    expect(normalizeConfig({ events: "abc" } as never).events).toEqual([]);
    expect(normalizeConfig({ events: ["b", 5, null, "a"] } as never).events).toEqual(["a", "b"]);
  });

  it("functionWrappers that is not a list, or whose entries have no name, no longer breaks reading", () => {
    expect(warnings({ functionWrappers: "x" }).join("\n")).toContain('"functionWrappers"');
    expect(warnings({ functionWrappers: [{ name: "a" }, { nope: 1 }, null, { name: "a" }] }).join("\n")).toContain('"functionWrappers"');
    expect(normalizeConfig({ functionWrappers: "x" } as never).functionWrappers).toEqual([]);
    expect(normalizeConfig({ functionWrappers: [{ name: "a" }, { nope: 1 }, null, { name: "a" }] } as never).functionWrappers).toEqual([{ name: "a" }]);
  });

  it("dynamicEvents that is not a list, or that holds a name that cannot be used", () => {
    expect(warnings({ dynamicEvents: "unique-dyn-string" }).join("\n")).toContain('"dynamicEvents"');
    expect(warnings({ dynamicEvents: ["ok.event", 7, "bad 😀 unique"] }).join("\n")).toContain("not a usable event name");
  });

  it("one sink entry that is not an object is told in the singular", () => {
    expect(warnings({ sinks: [{ preset: "posthog" }, 5] }).join("\n")).toMatch(/1 entry of "sinks".*is not an object/);
  });

  it("sync.maxFileSize that is not a positive whole number", () => {
    expect(warnings({ sync: { include: ["**/*.ts"], exclude: [], maxFileSize: "big-unique" } }).join("\n")).toContain("maxFileSize");
    expect(warnings({ sync: { include: ["**/*.ts"], exclude: [], maxFileSize: 5_000_000 } })).toEqual([]);
  });

  it("a value that is fine says nothing", () => {
    expect(warnings({ events: ["a"], functionWrappers: [{ name: "w" }], sinks: [{ preset: "posthog" }], dynamicEvents: ["d.e"] })).toEqual([]);
  });

  it("globs: a pattern with / keeps its backslash escapes, one without it is Windows-style", () => {
    const out = normalizeConfig({ sync: { include: ["src/\\(g\\)/*.ts", "src\\**\\*.ts", "app\\(group)\\*.ts"], exclude: [] } });
    expect(out.sync.include).toEqual(["src/\\(g\\)/*.ts", "src/**/*.ts", "app/(group)/*.ts"]);
  });
});
