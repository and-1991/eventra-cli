import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { analyzeWrapperPropagation } from "../../src/analysis/scanner/analyzer/propagationAnalyzer";
import { TrackSink, TrackedArgument } from "../../src/analysis/shared/propagation";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propagation-analyzer-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function findFunctionDeclaration(root: ts.Node, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error(`function ${name} not found`);
  return found;
}

function findFunctionExpression(root: ts.Node): ts.FunctionExpression {
  let found: ts.FunctionExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error("function expression not found");
  return found;
}

/** First call to `calleeName(...)` found within `root` (DFS). */
function findCall(root: ts.Node, calleeName: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error(`call to ${calleeName} not found`);
  return found;
}

function sink(call: ts.CallExpression, trackedArguments: readonly TrackedArgument[]): TrackSink {
  return { call, trackedArguments };
}

describe("analyzeWrapperPropagation", () => {
  it("resolves a direct identifier argument that matches a parameter", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper(name) {
          output(name);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).not.toBeNull();
      expect(result?.propagations).toHaveLength(1);
      expect(result?.propagations[0].sourceParameterIndex).toBe(0);
      expect(result?.propagations[0].propertyPath).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("returns null when the argument identifier doesn't resolve to any parameter", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper() {
          const other = "x";
          output(other);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("resolves a single-level property access rooted at a parameter", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper(props) {
          output(props.event);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result?.propagations).toHaveLength(1);
      expect(result?.propagations[0].propertyPath).toEqual(["event"]);
    } finally {
      cleanup();
    }
  });

  it("resolves an optional-chained property access (PropertyAccessChain)", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper(props) {
          output(props?.event);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result?.propagations).toHaveLength(1);
      expect(result?.propagations[0].propertyPath).toEqual(["event"]);
    } finally {
      cleanup();
    }
  });

  it("resolves an element access with a string literal key", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper(props) {
          output(props["event"]);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result?.propagations).toHaveLength(1);
      expect(result?.propagations[0].propertyPath).toEqual(["event"]);
    } finally {
      cleanup();
    }
  });

  it("falls back to an empty property path when an element access key isn't a string literal, but still resolves the root parameter", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper(props, i) {
          output(props[i]);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result?.propagations).toHaveLength(1);
      // extractPropertyPath returns null (the key isn't a string literal), so
      // the property path falls back to [] even though the root ("props")
      // still resolves to a parameter.
      expect(result?.propagations[0].propertyPath).toEqual([]);
      expect(result?.propagations[0].sourceParameterIndex).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("ignores a property access whose root is not an identifier (e.g. a call expression)", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function getProps() {
          return { event: "x" };
        }
        function wrapper() {
          output(getProps().event);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("collects object-literal argument propagations: shorthand + renamed matches, skipping spreads, literals, and unresolved identifiers", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper(a, b) {
          const rest = {};
          const c = "z";
          output({ ...rest, a, event: b, lit: "literal", missing: c });
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).not.toBeNull();
      // "...rest" is a spread (skipped), "lit" is a literal initializer
      // (skipped), and "missing" resolves to a non-parameter identifier
      // (skipped) — only the shorthand "a" and renamed "event: b" resolve.
      expect(result?.propagations).toHaveLength(2);
      const indices = result?.propagations.map((p) => p.sourceParameterIndex).sort();
      expect(indices).toEqual([0, 1]);
    } finally {
      cleanup();
    }
  });

  it("skips a tracked argument index that doesn't exist on the call", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper(a) {
          output();
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("ignores a tracked argument that is neither an identifier/property access nor an object literal", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper(a) {
          output(42);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("resolves a destructured parameter via a direct alias match", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper({ event }) {
          output(event);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result?.propagations).toHaveLength(1);
      expect(result?.propagations[0].propertyPath).toEqual(["event"]);
    } finally {
      cleanup();
    }
  });

  it("resolves a renamed destructured parameter (propertyName differs from the bound identifier)", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper({ event: name }) {
          output(name);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result?.propagations).toHaveLength(1);
      expect(result?.propagations[0].propertyPath).toEqual(["event"]);
    } finally {
      cleanup();
    }
  });

  it("resolves a nested destructured parameter", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper({ meta: { event } }) {
          output(event);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result?.propagations).toHaveLength(1);
      expect(result?.propagations[0].propertyPath).toEqual(["meta", "event"]);
    } finally {
      cleanup();
    }
  });

  it("returns null when a nested destructured pattern doesn't contain the looked-up identifier", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper({ meta: { other } }) {
          const external = "y";
          output(external);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns null when a destructured parameter has no binding matching the looked-up identifier", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper({ other }) {
          const external = "y";
          output(external);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  // Computed property names aren't valid in real destructuring parameters,
  // but the parser still produces the AST shape (propertyName is a
  // ComputedPropertyName, not an Identifier), so resolveObjectBinding's
  // defensive `!propertyName` guard is reachable and must be exercised.
  it("skips a binding element whose property name cannot be determined (computed key)", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        const x = "event";
        function wrapper({ [x]: { event } }) {
          output(event);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("skips a non-identifier, non-destructuring parameter (e.g. array binding) while resolving a later parameter", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function wrapper([a, b], name) {
          output(name);
        }
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionDeclaration(source, "wrapper");
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result?.propagations).toHaveLength(1);
      expect(result?.propagations[0].sourceParameterIndex).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("returns null when the function has no resolvable symbol (e.g. an anonymous callback)", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function addListener(cb) {
          cb("ignored");
        }
        addListener(function (event) {
          output(event);
        });
      `,
      );
      const source = ctx.getSourceFile(file)!;
      const checker = ctx.getChecker();
      const fn = findFunctionExpression(source);
      const call = findCall(fn, "output");
      const result = analyzeWrapperPropagation(fn, checker, [sink(call, [{ index: 0, propertyPath: [] }])]);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });
});
