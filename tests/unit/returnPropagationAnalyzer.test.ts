import { describe, expect, it } from "vitest";
import ts from "typescript";

import { analyzeReturnPropagation } from "../../src/analysis/scanner/analyzer/returnPropagationAnalyzer";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function findFunctionDeclaration(root: ts.Node, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) {
    throw new Error(`function ${name} not found`);
  }
  return found;
}

describe("analyzeReturnPropagation", () => {
  it("collects a direct identifier return that binds to a parameter", () => {
    const source = parse(`
      function makeEvent(event) {
        return event;
      }
    `);
    const fn = findFunctionDeclaration(source, "makeEvent");
    const result = analyzeReturnPropagation(fn);
    expect(result).not.toBeNull();
    expect(result?.propagations).toHaveLength(1);
    expect(result?.propagations[0].parameterIndex).toBe(0);
    expect(result?.propagations[0].returnExpression.getText()).toBe("event");
  });

  it("returns null when the returned identifier is not a parameter of the function", () => {
    const source = parse(`
      const other = "value";
      function makeEvent() {
        return other;
      }
    `);
    const fn = findFunctionDeclaration(source, "makeEvent");
    const result = analyzeReturnPropagation(fn);
    expect(result).toBeNull();
  });

  it("collects object literal returns, skipping shorthand, literal, and unresolved entries", () => {
    const source = parse(`
      const unknownVar = "x";
      function makeEvent(a, b) {
        return { a, event: b, lit: "literal", missing: unknownVar };
      }
    `);
    const fn = findFunctionDeclaration(source, "makeEvent");
    const result = analyzeReturnPropagation(fn);
    expect(result).not.toBeNull();
    // only "event: b" resolves to a parameter; "a" is shorthand (skipped),
    // "lit" is a string literal initializer (skipped), "missing" resolves to
    // a non-parameter identifier (skipped).
    expect(result?.propagations).toHaveLength(1);
    expect(result?.propagations[0].parameterIndex).toBe(1);
    expect(result?.propagations[0].returnExpression.getText()).toBe("b");
  });

  it("collects template-literal span returns, skipping non-identifier and unresolved spans", () => {
    const source = parse(`
      const unknownVar2 = "y";
      function makeEvent(name) {
        return \`prefix-\${name}-\${unknownVar2}-\${1 + 1}\`;
      }
    `);
    const fn = findFunctionDeclaration(source, "makeEvent");
    const result = analyzeReturnPropagation(fn);
    expect(result).not.toBeNull();
    // only the "name" span is an identifier that resolves to a parameter;
    // "unknownVar2" is an identifier but not a parameter, and "1 + 1" isn't
    // an identifier at all.
    expect(result?.propagations).toHaveLength(1);
    expect(result?.propagations[0].parameterIndex).toBe(0);
  });

  it("skips non-identifier parameters (e.g. destructuring) while resolving a later identifier parameter", () => {
    const source = parse(`
      function makeEvent({ x }, name) {
        return name;
      }
    `);
    const fn = findFunctionDeclaration(source, "makeEvent");
    const result = analyzeReturnPropagation(fn);
    expect(result).not.toBeNull();
    expect(result?.propagations).toHaveLength(1);
    expect(result?.propagations[0].parameterIndex).toBe(1);
  });

  it("returns null for a function declaration with no body (e.g. an overload signature)", () => {
    const source = parse(`
      declare function makeEvent(event: string): void;
    `);
    const fn = findFunctionDeclaration(source, "makeEvent");
    expect(fn.body).toBeUndefined();
    const result = analyzeReturnPropagation(fn);
    expect(result).toBeNull();
  });

  it("returns null when no return statement propagates a parameter", () => {
    const source = parse(`
      function makeEvent(event) {
        return 42;
      }
    `);
    const fn = findFunctionDeclaration(source, "makeEvent");
    const result = analyzeReturnPropagation(fn);
    expect(result).toBeNull();
  });

  it("combines multiple return statements across identifier, object, and template forms", () => {
    const source = parse(`
      const unknownVar = "x";
      function makeEvent(a, b, name) {
        if (a) {
          return a;
        }
        if (b) {
          return { a, event: b, lit: "literal", missing: unknownVar };
        }
        return \`prefix-\${name}-\${unknownVar}-\${1 + 1}\`;
      }
    `);
    const fn = findFunctionDeclaration(source, "makeEvent");
    const result = analyzeReturnPropagation(fn);
    expect(result).not.toBeNull();
    expect(result?.propagations.length).toBeGreaterThanOrEqual(3);
    const indices = result?.propagations.map((p) => p.parameterIndex);
    expect(indices).toContain(0);
    expect(indices).toContain(1);
    expect(indices).toContain(2);
  });
});
