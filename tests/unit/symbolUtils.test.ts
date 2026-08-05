import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { getFunctionSymbol } from "../../src/analysis/symbols/symbolUtils";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symbolutils-"));
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

describe("getFunctionSymbol", () => {
  it("resolves a named function declaration by its name", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `function trackFeature() {}`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isFunctionDeclaration);

      const symbol = getFunctionSymbol(node, ctx.getChecker());
      expect(symbol?.getName()).toBe("trackFeature");
    } finally {
      cleanup();
    }
  });

  it("resolves a class method with an identifier name", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `class Service { trackFeature() {} }`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isMethodDeclaration);

      const symbol = getFunctionSymbol(node, ctx.getChecker());
      expect(symbol?.getName()).toBe("trackFeature");
    } finally {
      cleanup();
    }
  });

  it("resolves an object literal method with a computed property name", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `const key = "trackFeature"; const obj = { [key]() {} };`,
      );
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isMethodDeclaration);
      expect(ts.isComputedPropertyName(node.name)).toBe(true);

      const symbol = getFunctionSymbol(node, ctx.getChecker());
      // The computed key resolves to the `key` identifier's symbol, not a "trackFeature" symbol.
      expect(symbol?.getName()).toBe("key");
    } finally {
      cleanup();
    }
  });

  it("resolves an arrow function assigned via a variable declaration", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `const trackFeature = () => {};`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isArrowFunction);

      const symbol = getFunctionSymbol(node, ctx.getChecker());
      expect(symbol?.getName()).toBe("trackFeature");
    } finally {
      cleanup();
    }
  });

  it("resolves an arrow function assigned to a class field", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `class Service { trackFeature = () => {}; }`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isArrowFunction);

      const symbol = getFunctionSymbol(node, ctx.getChecker());
      expect(symbol?.getName()).toBe("trackFeature");
    } finally {
      cleanup();
    }
  });

  it("resolves an arrow function assigned as an object property", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `const obj = { trackFeature: () => {} };`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isArrowFunction);

      const symbol = getFunctionSymbol(node, ctx.getChecker());
      expect(symbol?.getName()).toBe("trackFeature");
    } finally {
      cleanup();
    }
  });

  it("takes the export-assignment branch for a function exported as the default with no name", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `export default () => {};`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isArrowFunction);
      const checker = ctx.getChecker();
      expect(ts.isExportAssignment(node.parent)).toBe(true);

      // The export-assignment branch delegates straight to `checker.getSymbolAtLocation(node)`;
      // an anonymous arrow has no bound symbol of its own, so this legitimately resolves to
      // undefined — asserting the exact value it returns rather than a truthy stand-in.
      expect(getFunctionSymbol(node, checker)).toBe(checker.getSymbolAtLocation(node));
    } finally {
      cleanup();
    }
  });

  it("returns undefined for a function with no matching shape", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, `[() => {}];`);
      const sourceFile = ctx.getSourceFile(file)!;
      const node = findNode(sourceFile, ts.isArrowFunction);

      const symbol = getFunctionSymbol(node, ctx.getChecker());
      expect(symbol).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
