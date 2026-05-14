import ts from "typescript";

import {EvaluationCache} from "./evaluationCache";
import {ResolvedCallCache} from "./resolvedCallCache";
import {ResolvedExportCache} from "./resolvedExportCache";
import {ReturnPropagationCache} from "./returnPropagationCache";
import {WrapperRegistry} from "../symbols/wrapperRegistry";

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

export function invalidateSourceFileSymbols(sourceFile: ts.SourceFile, checker: ts.TypeChecker, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache, resolvedExportCache: ResolvedExportCache, returnPropagationCache: ReturnPropagationCache, wrapperRegistry: WrapperRegistry): void {
  function visit(node: ts.Node): void {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      evaluationCache.delete(symbol);
      resolvedCallCache.delete(symbol);
      resolvedExportCache.delete(symbol);
      wrapperRegistry.delete(symbol);
    }
    if (isFunctionLike(node)) {
      returnPropagationCache.delete(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}
