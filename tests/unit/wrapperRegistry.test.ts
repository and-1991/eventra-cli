import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { WrapperRegistry } from "../../src/analysis/symbols/wrapperRegistry";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { getFunctionSymbol } from "../../src/analysis/symbols/symbolUtils";
import { WrapperSemanticInfo } from "../../src/analysis/shared/propagation";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrapperregistry-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function findNode<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T {
  let found: T | undefined;
  const visit = (node: ts.Node) => {
    if (!found && predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) {
    throw new Error("node not found in fixture source");
  }
  return found;
}

function makeWrapperInfo(symbol: ts.Symbol, declaration: ts.FunctionLikeDeclaration): WrapperSemanticInfo {
  return { symbol, declaration, propagations: [] };
}

describe("WrapperRegistry", () => {
  it("set() then get() by the same symbol returns the stored semantic info", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `function trackFeature() {}`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isFunctionDeclaration);
      const checker = ctx.getChecker();
      const symbol = getFunctionSymbol(node, checker)!;

      const registry = new WrapperRegistry(checker, new ResolvedExportCache());
      const info = makeWrapperInfo(symbol, node);
      registry.set(info);

      expect(registry.get(symbol)).toBe(info);
      expect(registry.has(symbol)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("get() accepts a FunctionLikeDeclaration and resolves its symbol internally", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `function trackFeature() {}`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isFunctionDeclaration);
      const checker = ctx.getChecker();
      const symbol = getFunctionSymbol(node, checker)!;

      const registry = new WrapperRegistry(checker, new ResolvedExportCache());
      const info = makeWrapperInfo(symbol, node);
      registry.set(info);

      expect(registry.get(node)).toBe(info);
    } finally {
      cleanup();
    }
  });

  it("get() returns undefined when given a declaration with no resolvable symbol", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      // An arrow function with no matching parent shape (array element) has no resolvable symbol.
      ctx.updateFile(file, `[() => {}];`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isArrowFunction);
      const checker = ctx.getChecker();

      const registry = new WrapperRegistry(checker, new ResolvedExportCache());

      expect(registry.get(node)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("delete() removes a registered wrapper", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `function trackFeature() {}`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isFunctionDeclaration);
      const checker = ctx.getChecker();
      const symbol = getFunctionSymbol(node, checker)!;

      const registry = new WrapperRegistry(checker, new ResolvedExportCache());
      registry.set(makeWrapperInfo(symbol, node));
      expect(registry.has(symbol)).toBe(true);

      registry.delete(symbol);
      expect(registry.has(symbol)).toBe(false);
      expect(registry.get(symbol)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("clear() drops every registered wrapper", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `function trackFeature() {}`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isFunctionDeclaration);
      const checker = ctx.getChecker();
      const symbol = getFunctionSymbol(node, checker)!;

      const registry = new WrapperRegistry(checker, new ResolvedExportCache());
      registry.set(makeWrapperInfo(symbol, node));
      expect(registry.has(symbol)).toBe(true);

      registry.clear();
      expect(registry.has(symbol)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("falls back to the raw symbol when resolveExportedSymbol finds no concrete declaration", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      // An object-literal property's symbol only has a PropertyAssignment
      // declaration, which resolveExportedSymbol doesn't treat as concrete -
      // it returns null, exercising normalize()'s `?? symbol` fallback.
      ctx.updateFile(file, `const obj = { foo: () => {} };`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isArrowFunction);
      const checker = ctx.getChecker();
      const symbol = getFunctionSymbol(node, checker)!;

      const registry = new WrapperRegistry(checker, new ResolvedExportCache());
      const info = makeWrapperInfo(symbol, node);
      registry.set(info);

      expect(registry.get(symbol)).toBe(info);
      expect(registry.has(symbol)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("setChecker()/getChecker() swap the checker used for subsequent lookups", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `function trackFeature() {}`);
      const firstChecker = ctx.getChecker();

      const registry = new WrapperRegistry(firstChecker, new ResolvedExportCache());
      expect(registry.getChecker()).toBe(firstChecker);

      // Rebuild the program (simulating an incremental update) and swap in the new checker,
      // mirroring how EventraEngine refreshes wrapperRegistry after re-analysis.
      ctx.updateFile(file, `function trackFeature() { return 1; }`);
      const secondChecker = ctx.getChecker();
      registry.setChecker(secondChecker);

      expect(registry.getChecker()).toBe(secondChecker);
      expect(registry.getChecker()).not.toBe(firstChecker);
    } finally {
      cleanup();
    }
  });
});
