import ts from "typescript";

import {resolveFunctionFromCall} from "../resolver/callResolver";
import {resolveNodeValue} from "../resolver/resolver";
import {createEvaluationContext} from "../shared/evaluationContext";
import {WrapperRegistry} from "../symbols/wrapperRegistry";
import {WrapperPropagation} from "../shared/propagation";
import {ResolvedCallCache} from "../cache/resolvedCallCache";
import {ResolvedExportCache} from "../cache/resolvedExportCache";
import {EvaluationCache} from "../cache/evaluationCache";
import {ReturnPropagationCache} from "../cache/returnPropagationCache";

function isValidEvent(value: string): boolean {
  return (value.length > 0 && value.length < 160 && /^[a-zA-Z0-9:_./-]+$/.test(value));
}

function resolveObjectPath(expression: ts.Expression, path: readonly string[],): ts.Expression | null {
  let current: ts.Expression = expression;
  for (const segment of path) {
    if (!ts.isObjectLiteralExpression(current)) {
      return null;
    }
    let matched: ts.Expression | null = null;
    for (const property of current.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        continue;
      }
      const propertyName = ts.isIdentifier(property.name) ? property.name.text : ts.isStringLiteral(property.name) ? property.name.text : property.name.getText();
      if (propertyName !== segment) {
        continue;
      }
      matched = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
      break;
    }
    if (!matched) {
      return null;
    }
    current = matched;
  }
  return current;
}

export function extractPropagationEvents(call: ts.CallExpression, checker: ts.TypeChecker, wrapperRegistry: WrapperRegistry, resolvedCallCache: ResolvedCallCache, returnPropagationCache: ReturnPropagationCache, evaluationCache: EvaluationCache, exportCache: ResolvedExportCache, events: Set<string>, visited: Set<ts.Signature>): void {
  const resolved = resolveFunctionFromCall(call.expression, checker, resolvedCallCache, exportCache);
  if (!resolved) {
    return;
  }
  const semantic = wrapperRegistry.get(resolved);
  if (!semantic) {
    return;
  }
  const signature = checker.getSignatureFromDeclaration(resolved);
  if (!signature) {
    return;
  }
  if (visited.has(signature)) {
    return;
  }
  visited.add(signature);
  try {
    for (const propagation of semantic.propagations) {
      extractPropagation(propagation, call, checker, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache, events);
    }
  } finally {
    visited.delete(signature);
  }
}

function extractPropagation(propagation: WrapperPropagation, call: ts.CallExpression, checker: ts.TypeChecker, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache, events: Set<string>): void {
  let argument = call.arguments[propagation.sourceParameterIndex];
  if (!argument) {
    return;
  }
  // wrapper({
  //   nested: {
  //     event: "x"
  //   }
  // })
  if (propagation.propertyPath.length > 0) {
    const resolvedPath = resolveObjectPath(argument, propagation.propertyPath);
    if (!resolvedPath) {
      return;
    }
    argument = resolvedPath;
  }
  const context = createEvaluationContext();
  const parameterSymbol = checker.getSymbolAtLocation(propagation.sourceParameter.name);
  if (parameterSymbol) {
    context.parameterBindings.set(parameterSymbol, argument);
  }
  const resolved = resolveNodeValue(propagation.targetNode, checker, context, new Set(), evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
  for (const value of resolved.values) {
    if (isValidEvent(value)) {
      events.add(value);
    }
  }
}
