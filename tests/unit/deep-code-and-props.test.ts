import ts from "typescript";
import { describe, expect, it } from "vitest";

import { classifyDynamic } from "../../src/analysis/shared/dynamicCause";
import { scanSource } from "../../src/analysis/scanner/scanner";
import { WrapperRegistry } from "../../src/analysis/symbols/wrapperRegistry";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";

function program(code: string, fileName = "/virtual/a.tsx") {
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) => (name === fileName ? ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true) : original(name, ...rest));
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  host.readFile = (name) => (name === fileName ? code : ts.sys.readFile(name));
  const p = ts.createProgram([fileName], { jsx: ts.JsxEmit.Preserve, noLib: true, noResolve: true }, host);
  const checker = p.getTypeChecker();
  return { source: p.getSourceFile(fileName)!, checker, registry: new WrapperRegistry(checker, new ResolvedExportCache()) };
}

describe("scanSource on very deep code", () => {
  it("does not overflow the call stack on a long chain of +", () => {
    const code = `const x = ${Array.from({ length: 12000 }, () => '"a"').join(" + ")};\n`;
    const { source, checker, registry } = program(code, "/virtual/deep.ts");
    expect(() => scanSource(source, checker, registry, createBuiltinPluginRegistry())).not.toThrow();
  });

  it("visits nodes in source order, as before", () => {
    const { source, checker, registry } = program(`function a() {}\nfunction b() {}\nconst c = () => {};\n`);
    const index = scanSource(source, checker, registry, createBuiltinPluginRegistry());
    expect(index.functions.map((fn) => (ts.isFunctionDeclaration(fn) ? fn.name!.text : "arrow"))).toEqual(["a", "b", "arrow"]);
  });
});

describe("classifyDynamic: a class component's props", () => {
  const classify = (code: string, pick: (source: ts.SourceFile) => ts.Expression) => {
    const { source, checker } = program(code);
    return classifyDynamic(pick(source), checker);
  };
  const firstTrackArgument = (source: ts.SourceFile): ts.Expression => {
    let found: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (!found && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "track") found = node.arguments[0];
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found!;
  };

  it("treats `const { x } = this.props` like `this.props.x`: a wrapper, not an unknown name", () => {
    const direct = classify(`class C { go() { t.track(this.props.x); } }`, firstTrackArgument);
    const destructured = classify(`class C { go() { const { x } = this.props; t.track(x); } }`, firstTrackArgument);
    expect(direct.kind).toBe("wrapper");
    expect(destructured.kind).toBe("wrapper");
  });

  it("still calls state and other this reads a variable", () => {
    expect(classify(`class C { go() { t.track(this.state.x); } }`, firstTrackArgument).kind).toBe("unresolved");
    expect(classify(`class C { go() { const { x } = this.state; t.track(x); } }`, firstTrackArgument).kind).toBe("unresolved");
  });
});
