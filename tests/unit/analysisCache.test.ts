import { describe, expect, it } from "vitest";
import ts from "typescript";

import { EvaluationCache } from "../../src/analysis/cache/evaluationCache";
import { ResolvedCallCache } from "../../src/analysis/cache/resolvedCallCache";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { ReturnPropagationCache } from "../../src/analysis/cache/returnPropagationCache";
import { buildProject, findIdentifier } from "./resolverTestUtils";

// All four cache classes are thin WeakMap wrappers keyed by real ts.Symbol /
// ts.FunctionLikeDeclaration objects. We build a tiny real program so the
// keys used below are genuine compiler objects, not hand-mocked stand-ins.
function realSymbolAndFunction() {
  const project = buildProject(
    {
      "a.ts": `
        export const value = "hello";
        export function trackFeature(event: string): void {
          console.log(event);
        }
      `,
    },
    "analysis-cache-",
  );
  const sf = project.file("a.ts");
  const symbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "value", 0));
  if (!symbol) {
    throw new Error("expected symbol for `value`");
  }
  const fnDeclaration = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s),
  );
  if (!fnDeclaration) {
    throw new Error("expected function declaration");
  }
  return { project, symbol, fnDeclaration };
}

describe("EvaluationCache", () => {
  it("set/get/delete/clear round-trip on a real ts.Symbol", () => {
    const { project, symbol } = realSymbolAndFunction();
    try {
      const cache = new EvaluationCache();
      expect(cache.get(symbol)).toBeUndefined();

      const result = { values: ["hello"], dynamic: false };
      cache.set(symbol, result);
      expect(cache.get(symbol)).toBe(result);

      cache.delete(symbol);
      expect(cache.get(symbol)).toBeUndefined();

      cache.set(symbol, result);
      cache.clear();
      expect(cache.get(symbol)).toBeUndefined();
    } finally {
      project.cleanup();
    }
  });
});

describe("ResolvedCallCache", () => {
  it("set/get/delete/clear round-trip on a real ts.Symbol", () => {
    const { project, symbol, fnDeclaration } = realSymbolAndFunction();
    try {
      const cache = new ResolvedCallCache();
      expect(cache.get(symbol)).toBeUndefined();

      cache.set(symbol, fnDeclaration);
      expect(cache.get(symbol)).toBe(fnDeclaration);

      cache.delete(symbol);
      expect(cache.get(symbol)).toBeUndefined();

      cache.set(symbol, null);
      expect(cache.get(symbol)).toBeNull();

      cache.clear();
      expect(cache.get(symbol)).toBeUndefined();
    } finally {
      project.cleanup();
    }
  });
});

describe("ResolvedExportCache", () => {
  it("set/get/delete/clear round-trip on a real ts.Symbol", () => {
    const { project, symbol } = realSymbolAndFunction();
    try {
      const cache = new ResolvedExportCache();
      expect(cache.get(symbol)).toBeUndefined();

      cache.set(symbol, symbol);
      expect(cache.get(symbol)).toBe(symbol);

      cache.delete(symbol);
      expect(cache.get(symbol)).toBeUndefined();

      cache.set(symbol, null);
      expect(cache.get(symbol)).toBeNull();

      cache.clear();
      expect(cache.get(symbol)).toBeUndefined();
    } finally {
      project.cleanup();
    }
  });
});

describe("ReturnPropagationCache", () => {
  it("set/get/delete/clear round-trip on a real ts.FunctionLikeDeclaration", () => {
    const { project, fnDeclaration } = realSymbolAndFunction();
    try {
      const cache = new ReturnPropagationCache();
      expect(cache.get(fnDeclaration)).toBeUndefined();

      const info = { declaration: fnDeclaration, propagations: [] };
      cache.set(fnDeclaration, info);
      expect(cache.get(fnDeclaration)).toBe(info);

      cache.delete(fnDeclaration);
      expect(cache.get(fnDeclaration)).toBeUndefined();

      cache.set(fnDeclaration, null);
      expect(cache.get(fnDeclaration)).toBeNull();

      cache.clear();
      expect(cache.get(fnDeclaration)).toBeUndefined();
    } finally {
      project.cleanup();
    }
  });
});
