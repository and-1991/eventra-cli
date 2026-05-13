// src/analysis/cache/symbolInvalidation.ts

import ts from "typescript";

import {
  EvaluationCache,
} from "./evaluationCache";

import {
  ResolvedCallCache,
} from "./resolvedCallCache";

import {
  ResolvedExportCache,
} from "./resolvedExportCache";

export function invalidateSourceFileSymbols(
  sourceFile: ts.SourceFile,

  checker: ts.TypeChecker,

  evaluationCache:
  EvaluationCache,

  resolvedCallCache:
  ResolvedCallCache,

  resolvedExportCache:
  ResolvedExportCache,
): void {

  function visit(
    node: ts.Node,
  ): void {

    const symbol =
      checker.getSymbolAtLocation(
        node,
      );

    if (symbol) {

      evaluationCache.delete(
        symbol,
      );

      resolvedCallCache.delete(
        symbol,
      );

      resolvedExportCache.delete(
        symbol,
      );
    }

    ts.forEachChild(
      node,
      visit,
    );
  }

  visit(
    sourceFile,
  );
}
