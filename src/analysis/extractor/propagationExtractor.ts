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
import {normalizeEventName} from "../shared/eventValidation";
import {DynamicOccurrence, recordDynamicOccurrence} from "../shared/dynamicOccurrence";

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

export function extractPropagationEvents(call: ts.CallExpression, checker: ts.TypeChecker, wrapperRegistry: WrapperRegistry, resolvedCallCache: ResolvedCallCache, returnPropagationCache: ReturnPropagationCache, evaluationCache: EvaluationCache, exportCache: ResolvedExportCache, events: Set<string>, visited: Set<ts.Signature>, dynamicOccurrences: DynamicOccurrence[]): void {
  const resolved = resolveFunctionFromCall(call.expression, checker, resolvedCallCache, exportCache);
  if (!resolved) {
    return;
  }
  const semantic = wrapperRegistry.get(resolved);
  if (!semantic) {
    return;
  }
  const signature = checker.getSignatureFromDeclaration(resolved);
  // resolveFunctionFromCall only ever returns a FunctionDeclaration,
  // MethodDeclaration, ArrowFunction, or FunctionExpression (verified: every
  // one of those kinds — including a bodyless ambient overload signature —
  // yields a signature from getSignatureFromDeclaration), so this guard has
  // no reachable failure case; it's defensive only.
  /* v8 ignore if */
  if (!signature) {
    return;
  }
  if (visited.has(signature)) {
    return;
  }
  visited.add(signature);
  try {
    for (const propagation of semantic.propagations) {
      extractPropagation(propagation, call, checker, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache, events, dynamicOccurrences);
    }
  } finally {
    visited.delete(signature);
  }
}

function extractPropagation(propagation: WrapperPropagation, call: ts.CallExpression, checker: ts.TypeChecker, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache, events: Set<string>, dynamicOccurrences: DynamicOccurrence[]): void {
  const argument = call.arguments[propagation.sourceParameterIndex];
  if (!argument) {
    return;
  }
  const context = createEvaluationContext();
  if (ts.isIdentifier(propagation.sourceParameter.name)) {
    // sourceParameter is a plain identifier (`function f(payload)`), so
    // propagation.targetNode — `payload`, `payload.event`, or any expression
    // a plugin builds from it (e.g. a template literal) — can resolve its own
    // propertyPath by evaluating targetNode with `payload` substituted for
    // the *raw*, un-narrowed call-site argument.
    const parameterSymbol = checker.getSymbolAtLocation(propagation.sourceParameter.name);
    // Every real ts.ParameterDeclaration identifier is bound to a symbol by
    // the TS binder (verified across ordinary functions, type-only function
    // types, interface call signatures, and ambient declarations), so
    // `parameterSymbol` is never undefined here; the guard is defensive only.
    /* v8 ignore else */
    if (parameterSymbol) {
      context.parameterBindings.set(parameterSymbol, argument);
    }
  } else {
    // sourceParameter is a destructuring pattern (`function f({ event })`),
    // which has no symbol of its own — `getSymbolAtLocation` on the pattern
    // returns nothing. Narrow to the leaf value ourselves via propertyPath,
    // then bind it to the destructured binding's own symbol (targetNode is
    // that binding's reference, e.g. `event` in `sdk.track(event)`).
    if (propagation.propertyPath.length === 0 || !ts.isIdentifier(propagation.targetNode)) {
      return;
    }
    const resolvedPath = resolveObjectPath(argument, propagation.propertyPath);
    if (!resolvedPath) {
      return;
    }
    const bindingSymbol = checker.getSymbolAtLocation(propagation.targetNode);
    if (!bindingSymbol) {
      return;
    }
    context.parameterBindings.set(bindingSymbol, resolvedPath);
  }
  const resolved = resolveNodeValue(propagation.targetNode, checker, context, new Set(), evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
  for (const value of resolved.values) {
    const normalized = normalizeEventName(value);
    if (normalized) {
      events.add(normalized);
    }
  }
  if (resolved.dynamic) {
    recordDynamicOccurrence(call, resolved.values, dynamicOccurrences);
  }
}
