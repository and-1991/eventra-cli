import ts from "typescript";

import {resolveExportedSymbol} from "./exportResolver";
import {EvaluationCache} from "../cache/evaluationCache";
import {ResolvedExportCache} from "../cache/resolvedExportCache";
import {EvaluationContext} from "../shared/evaluationContext";
import {analyzeReturnPropagation} from "../scanner/analyzer/returnPropagationAnalyzer";
import {resolveFunctionFromCall} from "./callResolver";
import {ResolvedCallCache} from "../cache/resolvedCallCache";
import {ReturnPropagationCache} from "../cache/returnPropagationCache";

export interface ResolveResult {
  readonly values: readonly string[];
  readonly dynamic: boolean;
}

function unique(values: readonly string[],): string[] {
  return [
    ...new Set(values),
  ];
}

function empty(): ResolveResult {
  return {
    values: [],
    dynamic: true,
  };
}

function concat(left: readonly string[], right: readonly string[],): string[] {
  const result: string[] = [];
  for (const l of left) {
    for (const r of right) {
      result.push(l + r);
    }
  }
  return unique(result);
}

function getPropertyName(node: ts.PropertyAccessExpression | ts.PropertyAccessChain | ts.ElementAccessExpression): string | null {
  if (ts.isElementAccessExpression(node)) {
    if (!node.argumentExpression || !ts.isStringLiteral(node.argumentExpression)) {
      return null;
    }
    return node.argumentExpression.text;
  }
  return node.name.text;
}

function resolvePropertyAccess(node: ts.PropertyAccessExpression | ts.PropertyAccessChain | ts.ElementAccessExpression, checker: ts.TypeChecker, context: EvaluationContext, visited: Set<ts.Node>, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache | undefined, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache): ResolveResult {
  const propertyName = getPropertyName(node);
  if (!propertyName) {
    return empty();
  }
  // payload.event
  // payload["event"]
  const targetExpression = ts.isElementAccessExpression(node) ? node.expression : node.expression;
  if (ts.isIdentifier(targetExpression)) {
    const symbol = checker.getSymbolAtLocation(targetExpression);
    // parameter binding
    if (symbol && context.parameterBindings.has(symbol)) {
      const bound = context.parameterBindings.get(symbol);
      if (bound && ts.isObjectLiteralExpression(bound)) {
        for (const property of bound.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            continue;
          }
          const objectPropertyName = ts.isIdentifier(property.name) ? property.name.text : property.name.getText();
          if (objectPropertyName !== propertyName) {
            continue;
          }
          const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
          return resolveNodeValue(initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        }
      }
    }
    // const EVENTS = {
    //   LOGIN: "login"
    // }
    if (symbol) {
      const declarations = symbol.getDeclarations() ?? [];
      for (const declaration of declarations) {
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
          continue;
        }
        for (const property of declaration.initializer.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            continue;
          }
          const objectPropertyName = ts.isIdentifier(property.name) ? property.name.text : property.name.getText();
          if (objectPropertyName !== propertyName) {
            continue;
          }
          const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
          return resolveNodeValue(initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        }
      }
    }
  }

  return empty();
}

function resolveIdentifier(node: ts.Identifier, checker: ts.TypeChecker, context: EvaluationContext, visited: Set<ts.Node>, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache | undefined, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache,): ResolveResult {
  const boundSymbol = checker.getSymbolAtLocation(node);
  if (boundSymbol && context.parameterBindings.has(boundSymbol)) {
    const bound = context.parameterBindings.get(boundSymbol);
    if (bound) {
      return resolveNodeValue(bound, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
  }
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return empty();
  }

  symbol = resolveExportedSymbol(symbol, checker, exportCache) ?? symbol;
  const cached = evaluationCache.get(symbol);
  if (cached) {
    return cached;
  }
  const resolving = empty();
  evaluationCache.set(symbol, resolving);
  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = resolveNodeValue(declaration.initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      evaluationCache.set(symbol, resolved);
      return resolved;
    }

    if (ts.isEnumMember(declaration) && declaration.initializer) {
      const resolved = resolveNodeValue(declaration.initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      evaluationCache.set(symbol, resolved);
      return resolved;
    }
  }

  return resolving;
}

function resolveCallExpression(node: ts.CallExpression, checker: ts.TypeChecker, context: EvaluationContext, visited: Set<ts.Node>, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache | undefined, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache): ResolveResult {
  const resolved = resolveFunctionFromCall(node.expression, checker, resolvedCallCache ?? new ResolvedCallCache(), exportCache);
  if (!resolved) {
    return empty();
  }
  let semantic = returnPropagationCache.get(resolved);
  if (semantic === undefined) {
    semantic = analyzeReturnPropagation(resolved);
    returnPropagationCache.set(resolved, semantic);
  }
  if (!semantic) {
    return empty();
  }
  const values: string[] = [];
  for (const propagation of semantic.propagations) {
    const argument = node.arguments[propagation.parameterIndex];
    if (!argument) {
      continue;
    }
    const nextContext = {
      parameterBindings: new Map(context.parameterBindings),
    };
    const parameterSymbol = checker.getSymbolAtLocation(propagation.parameter.name);
    if (parameterSymbol) {
      nextContext.parameterBindings.set(parameterSymbol, argument);
    }

    const resolvedValue = resolveNodeValue(propagation.returnExpression, checker, nextContext, new Set(visited), evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    values.push(...resolvedValue.values,);
  }
  return {
    values: unique(values),
    dynamic: true,
  };
}

export function resolveNodeValue(node: ts.Node, checker: ts.TypeChecker, context: EvaluationContext, visited: Set<ts.Node>, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache | undefined, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache): ResolveResult {
  if (visited.has(node)) {
    return empty();
  }
  visited.add(node);
  try {
    if (ts.isStringLiteral(node)) {
      return {
        values: [node.text],
        dynamic: false,
      };
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return {
        values: [node.text],
        dynamic: false,
      };
    }
    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans) {
        const resolved = resolveNodeValue(span.expression, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        values = concat(values, resolved.values.map(value => value + span.literal.text));
      }
      return {
        values: unique(values),
        dynamic: true,
      };
    }
    if (ts.isConditionalExpression(node)) {
      const whenTrue = resolveNodeValue(node.whenTrue, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      const whenFalse = resolveNodeValue(node.whenFalse, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      return {
        values: unique([...whenTrue.values, ...whenFalse.values]),
        dynamic: true,
      };
    }

    if (ts.isArrayLiteralExpression(node)) {
      const values: string[] = [];
      for (const element of node.elements) {
        const resolved = resolveNodeValue(element, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        values.push(...resolved.values);
      }
      return {
        values: unique(values),
        dynamic: true,
      };
    }

    if (ts.isObjectLiteralExpression(node)) {
      const values: string[] = [];
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          continue;
        }
        const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
        const resolved = resolveNodeValue(initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        values.push(...resolved.values);
      }
      return {
        values: unique(values),
        dynamic: true,
      };
    }
    if (ts.isParenthesizedExpression(node)) {
      return resolveNodeValue(node.expression, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return resolveNodeValue(node.expression, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node) || ts.isElementAccessExpression(node)) {
      return resolvePropertyAccess(node, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
    if (ts.isIdentifier(node)) {
      return resolveIdentifier(node, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveNodeValue(node.left, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      const right = resolveNodeValue(node.right, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      return {
        values: concat(left.values, right.values),
        dynamic: true,
      };
    }
    if (ts.isCallExpression(node)) {
      return resolveCallExpression(node, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
    return empty();
  } finally {
    visited.delete(node);
  }
}
