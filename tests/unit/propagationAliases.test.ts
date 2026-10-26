import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { analyzeWrapperPropagation } from "../../src/analysis/scanner/analyzer/propagationAnalyzer";
import { resolveWrapperChains } from "../../src/analysis/scanner/wrapperChains";
import { callSiteArgument, callSiteExpression, jsxPropsAsObjectLiteral } from "../../src/analysis/shared/callSite";
import { ResolvedCallCache } from "../../src/analysis/cache/resolvedCallCache";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { WrapperRegistry } from "../../src/analysis/symbols/wrapperRegistry";
import type { TrackedArgument } from "../../src/analysis/shared/propagation";
import type { FileSemanticIndex } from "../../src/analysis/shared/types";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function open(source: string, fileName = "a.ts") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propagation-aliases-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new CompilerContext(root);
  const file = path.join(root, fileName);
  ctx.updateFile(file, source);
  return { checker: ctx.getChecker(), sourceFile: ctx.getSourceFile(file)!, file };
}

function functions(root: ts.Node): ts.FunctionDeclaration[] {
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

const nameOf = (fn: ts.FunctionDeclaration): string => fn.name!.text;

function firstCall(root: ts.Node, callee: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found!;
}

/** What the analyzer finds for `wrapper`, with `output(...)` as the sink. */
function analyze(source: string, tracked: readonly TrackedArgument[] = [{ index: 0, propertyPath: [] }]) {
  const { checker, sourceFile } = open(source);
  const fn = functions(sourceFile).find((f) => nameOf(f) === "wrapper")!;
  const result = analyzeWrapperPropagation(fn, checker, [{ call: firstCall(fn, "output"), trackedArguments: tracked }]);
  return result?.propagations.map((p) => ({ index: p.sourceParameterIndex, path: p.propertyPath, alias: p.viaAlias === true }));
}

describe("analyzeWrapperPropagation: names that are a parameter in another form", () => {
  it("follows a plain alias, a read of a property and a nested destructuring", () => {
    expect(analyze("function wrapper(p) { const q = p; output(q.t); }")).toEqual([{ index: 0, path: ["t"], alias: true }]);
    expect(analyze("function wrapper(p) { const n = p.m.k; output(n); }")).toEqual([{ index: 0, path: ["m", "k"], alias: true }]);
    expect(analyze('function wrapper(p) { const n = p["m"]; output(n); }')).toEqual([{ index: 0, path: ["m"], alias: true }]);
    expect(analyze("function wrapper(p) { const { id } = p.meta; output(id); }")).toEqual([{ index: 0, path: ["meta", "id"], alias: true }]);
    expect(analyze("function wrapper(p) { const { a: { b } } = p; output(b); }")).toEqual([{ index: 0, path: ["a", "b"], alias: true }]);
    expect(analyze("function wrapper(p) { const { a: renamed } = p; output(renamed); }")).toEqual([{ index: 0, path: ["a"], alias: true }]);
  });

  it("treats a read it cannot name as the whole parameter", () => {
    expect(analyze("function wrapper(p, key) { const n = p[key]; output(n); }")).toEqual([{ index: 0, path: [], alias: true }]);
    expect(analyze("function wrapper(p, key) { output({ event: p[key] }); }", [{ index: 0, propertyPath: ["event"] }])).toEqual([{ index: 0, path: [], alias: false }]);
    expect(analyze("function wrapper(p, key) { const n = p[key]; output({ event: n }); }", [{ index: 0, propertyPath: ["event"] }])).toEqual([{ index: 0, path: [], alias: true }]);
  });

  it("follows an alias of a parameter that is itself destructured", () => {
    expect(analyze("function wrapper({ track }) { const t = track; output(t); }")).toEqual([{ index: 0, path: ["track"], alias: true }]);
  });

  it("follows aliases four deep and no further", () => {
    expect(analyze("function wrapper(p) { const a = p; const b = a; const c = b; const d = c; output(d); }")).toEqual([{ index: 0, path: [], alias: true }]);
    expect(analyze("function wrapper(p) { const a = p; const b = a; const c = b; const d = c; const e = d; output(e); }")).toBeUndefined();
  });

  it("reads an alias inside an object literal handed to the sink", () => {
    expect(analyze("function wrapper(p) { const q = p; output({ event: q.t }); }", [{ index: 0, propertyPath: ["event"] }])).toEqual([{ index: 0, path: ["t"], alias: true }]);
    expect(analyze("function wrapper(p) { output({ event: p.t, other: p.u }); }", [{ index: 0, propertyPath: ["event"] }])).toEqual([{ index: 0, path: ["t"], alias: false }]);
    expect(analyze("function wrapper(p) { output({ event: (p.t as string) }); }", [{ index: 0, propertyPath: ["event"] }])).toEqual([{ index: 0, path: ["t"], alias: false }]);
  });

  it("ignores a property read of something that is not a name", () => {
    expect(analyze("function wrapper(p) { output({ event: make().t }); }", [{ index: 0, propertyPath: ["event"] }])).toBeUndefined();
  });

  it("does not follow a name that is not a plain read of a parameter", () => {
    // rest elements, array patterns and anything but `const`
    expect(analyze("function wrapper(p) { const { ...rest } = p; output(rest.t); }")).toBeUndefined();
    expect(analyze("function wrapper(p) { const { a, ...rest } = p; output(rest.t); }")).toBeUndefined();
    expect(analyze("function wrapper(p) { const [first] = p; output(first); }")).toBeUndefined();
    expect(analyze("function wrapper(p) { const [{ b }] = p; output(b); }")).toBeUndefined();
    expect(analyze("function wrapper(p) { let q = p; output(q.t); }")).toBeUndefined();
    expect(analyze("function wrapper(p) { var q = p; output(q.t); }")).toBeUndefined();
    expect(analyze("function wrapper(p) { let q: any; output(q); }")).toBeUndefined();
    expect(analyze("function wrapper(p) { const q = make(p); output(q); }")).toBeUndefined();
    expect(analyze("function wrapper(p) { const q = other; output(q); }")).toBeUndefined();
  });

  it("does not take a parameter of an inner function for one of the wrapper", () => {
    expect(analyze("function wrapper(p) { [1].forEach((x) => output(x)); }")).toBeUndefined();
    expect(analyze("function wrapper(x) { [1].forEach((p) => output(p)); }")).toBeUndefined();
  });

  it("does not take a name declared outside the wrapper's body, even when it reads a name the wrapper also has", () => {
    expect(analyze("const t = p;\nfunction wrapper(p) { output(t); }")).toBeUndefined();
    expect(analyze("function wrapper(p) { output(t); }\nconst t = p;")).toBeUndefined();
  });

  it("finds a destructured parameter after one that does not hold the name, and past a nested pattern", () => {
    expect(analyze("function wrapper({ a }, { event }) { output(event); }")).toEqual([{ index: 1, path: ["event"], alias: false }]);
    expect(analyze("function wrapper({ meta: { id }, event }) { output(event); }")).toEqual([{ index: 0, path: ["event"], alias: false }]);
    expect(analyze("function wrapper({ meta: { id } }) { output(id); }")).toEqual([{ index: 0, path: ["meta", "id"], alias: false }]);
    expect(analyze("function wrapper([event]) { output(event); }")).toBeUndefined();
    expect(analyze("function wrapper(a, [event]) { output(event); }")).toBeUndefined();
  });
});

/** Registers the functions named in `direct` as wrappers of `output(...)`, then chains the others through them. */
function chain(source: string, direct: readonly string[], fileName = "a.ts") {
  const { checker, sourceFile, file } = open(source, fileName);
  const all = functions(sourceFile);
  const registry = new WrapperRegistry(checker, new ResolvedExportCache());
  for (const fn of all.filter((f) => direct.includes(nameOf(f)))) {
    registry.set(analyzeWrapperPropagation(fn, checker, [{ call: firstCall(fn, "output"), trackedArguments: [{ index: 0, propertyPath: [] }] }])!);
  }
  const index: FileSemanticIndex = { fileName: file, sourceFile, sinks: [], trackCalls: [], wrappers: [], functions: all };
  const callCache = new ResolvedCallCache();
  const exportCache = new ResolvedExportCache();
  const run = () => resolveWrapperChains([index], checker, registry, callCache, exportCache);
  const propagations = (name: string): number | undefined => registry.get(all.find((f) => nameOf(f) === name)!)?.propagations.length;
  return { run, file, propagations };
}

describe("resolveWrapperChains", () => {
  it("finds a wrapper that is only reached through a wrapper declared after it, however deep", () => {
    const { run, file, propagations } = chain(
      "function top(e) { mid(e); }\nfunction mid(e) { low(e); }\nfunction low(e) { cap(e); }\nfunction cap(e) { output(e); }",
      ["cap"],
    );
    expect(run().get(file)?.map((w) => nameOf(w.declaration as ts.FunctionDeclaration)).sort()).toEqual(["low", "mid", "top"]);
    expect(propagations("top")).toBe(1);
  });

  it("finds nothing the second time, and does not add a propagation it already has", () => {
    const { run, propagations } = chain("function t(a, b) { cap(a); cap(b); }\nfunction both(a) { output(a); cap(a); }\nfunction cap(e) { output(e); }", ["cap", "both"]);
    expect(run().size).toBe(1);
    expect(propagations("t")).toBe(2);
    expect(propagations("both")).toBe(2);
    expect(run().size).toBe(0);
    expect(propagations("t")).toBe(2);
    expect(propagations("both")).toBe(2);
  });

  it("keeps only the latest form of a wrapper that grew in a later round", () => {
    const { run, file, propagations } = chain("function t(a, b) { cap(a); mid(b); }\nfunction mid(x) { cap(x); }\nfunction cap(e) { output(e); }", ["cap"]);
    const found = run().get(file)!;
    expect(found.map((w) => nameOf(w.declaration as ts.FunctionDeclaration)).sort()).toEqual(["mid", "t"]);
    expect(propagations("t")).toBe(2);
  });

  it("does not chain a function through its own call", () => {
    const { run, propagations } = chain("function f(e) { f(e); cap(e); }\nfunction cap(e) { output(e); }", ["cap"]);
    run();
    expect(propagations("f")).toBe(1);
  });

  it("skips a call whose callee it cannot resolve, and a function with no body", () => {
    const { run, file } = chain("declare function declared(e: string): void;\nfunction t(e) { unknown(e); declared(e); }\nfunction cap(e) { output(e); }", ["cap"]);
    expect(run().get(file)).toBeUndefined();
  });

  it("chains a component through the component it renders, but not through an element or a whole props object", () => {
    const chained = chain("function Inner({ n }) { output(n); }\nfunction Outer({ t }) { return <Inner n={t} />; }", ["Inner"], "a.tsx");
    expect(chained.run().size).toBe(1);

    // a lowercase tag is an element, even when a function of that name is in scope
    const element = chain("function inner({ n }) { output(n); }\nfunction Outer({ t }) { return <inner n={t} />; }", ["inner"], "a.tsx");
    expect(element.run().size).toBe(0);

    // a component only receives props: forwarding the whole parameter says nothing about a prop
    const whole = chain("function Inner(props) { output(props); }\nfunction Outer({ t }) { return <Inner n={t} />; }", ["Inner"], "a.tsx");
    expect(whole.run().size).toBe(0);
  });
});

function jsx(source: string): ts.JsxSelfClosingElement | ts.JsxOpeningElement {
  const file = ts.createSourceFile("a.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.JsxSelfClosingElement | ts.JsxOpeningElement | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found!;
}

describe("callSite", () => {
  it("rebuilds the props of an element from its plain attributes", () => {
    const props = jsxPropsAsObjectLiteral(jsx('<B a="s" b={x} c={<I />} d={<I></I>} e={<></>} f={} g {...rest} h:i="n" j={y.z} />'));
    expect(props.properties.map((p) => (p as ts.PropertyAssignment).name.getText())).toEqual(["a", "b", "j"]);
    expect(props.properties.map((p) => (p as ts.PropertyAssignment).initializer.getText())).toEqual(['"s"', "x", "y.z"]);
    expect(jsxPropsAsObjectLiteral(jsx("<B />")).properties).toHaveLength(0);
  });

  it("names the called expression of a call and of an element, and none for a namespaced tag", () => {
    const file = ts.createSourceFile("a.ts", "f(1);", ts.ScriptTarget.Latest, true);
    const call = (file.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression;
    expect(callSiteExpression(call)).toBe(call.expression);
    expect(callSiteExpression(jsx("<B />"))?.getText()).toBe("B");
    expect(callSiteExpression(jsx("<Foo.Bar />"))?.getText()).toBe("Foo.Bar");
    expect(callSiteExpression(jsx("<svg:rect />"))).toBeNull();
  });

  it("hands over an argument of a call by index, and only the props object of an element", () => {
    const file = ts.createSourceFile("a.ts", "f(1, 2);", ts.ScriptTarget.Latest, true);
    const call = (file.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression;
    expect(callSiteArgument(call, 1)?.getText()).toBe("2");
    expect(callSiteArgument(call, 2)).toBeUndefined();
    const element = jsx('<B a="x" />');
    expect(callSiteArgument(element, 0)).toBeDefined();
    expect(ts.isObjectLiteralExpression(callSiteArgument(element, 0)!)).toBe(true);
    expect(callSiteArgument(element, 1)).toBeUndefined();
  });
});
