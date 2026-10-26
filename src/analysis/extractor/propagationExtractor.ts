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
import {getValueSymbol} from "../symbols/symbolUtils";
import {eventNameRejection, normalizeEventName} from "../shared/eventValidation";
import {DynamicOccurrence, RejectedName, recordDynamicOccurrence, recordRejectedName} from "../shared/dynamicOccurrence";
import {callSiteArgument, callSiteExpression, WrapperCallSite} from "../shared/callSite";

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

export function extractPropagationEvents(call: WrapperCallSite, checker: ts.TypeChecker, wrapperRegistry: WrapperRegistry, resolvedCallCache: ResolvedCallCache, returnPropagationCache: ReturnPropagationCache, evaluationCache: EvaluationCache, exportCache: ResolvedExportCache, events: Set<string>, visited: Set<ts.Signature>, dynamicOccurrences: DynamicOccurrence[], rejectedNames: RejectedName[]): void {
  const callee = callSiteExpression(call);
  const resolved = callee && resolveFunctionFromCall(callee, checker, resolvedCallCache, exportCache);
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
      // A component only ever receives props (an object), so a propagation that reads the
      // parameter as a whole (`name` rather than `props.name`) can't be satisfied by a JSX site.
      if (!ts.isCallExpression(call) && (propagation.sourceParameterIndex !== 0 || propagation.propertyPath.length === 0)) {
        continue;
      }
      extractPropagation(propagation, call, checker, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache, events, dynamicOccurrences, rejectedNames);
    }
  } finally {
    visited.delete(signature);
  }
}

function extractPropagation(propagation: WrapperPropagation, call: WrapperCallSite, checker: ts.TypeChecker, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache, events: Set<string>, dynamicOccurrences: DynamicOccurrence[], rejectedNames: RejectedName[]): void {
  // Call site can omit the argument and rely on the parameter's own default
  // value (`function f(event = "x") {}` called as `f()`) - that default is a
  // real static literal, so fall back to it instead of dropping the call site.
  const argument = callSiteArgument(call, propagation.sourceParameterIndex) ?? propagation.sourceParameter.initializer;
  if (!argument) {
    return;
  }
  const context = createEvaluationContext();
  let directTarget: ts.Expression | undefined;
  if (propagation.viaAlias) {
    // `const { track } = props; sdk.track(track)`: the sink's own node is a local, not the parameter,
    // so the value is whatever the call site passes at the path the alias reads
    const leaf = propagation.propertyPath.length === 0 ? argument : resolveObjectPath(argument, propagation.propertyPath);
    if (!leaf) {
      return;
    }
    directTarget = leaf;
  } else if (ts.isIdentifier(propagation.sourceParameter.name)) {
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
    if (propagation.propertyPath.length === 0) {
      return;
    }
    const resolvedPath = resolveObjectPath(argument, propagation.propertyPath);
    if (!resolvedPath) {
      return;
    }
    if (ts.isIdentifier(propagation.targetNode)) {
      const bindingSymbol = getValueSymbol(propagation.targetNode, checker);
      if (!bindingSymbol) {
        return;
      }
      context.parameterBindings.set(bindingSymbol, resolvedPath);
    } else if (ts.isPropertyAccessExpression(propagation.targetNode) || ts.isElementAccessExpression(propagation.targetNode)) {
      // `function f({ analytics }) { track(analytics.name) }`: propertyPath already walks the binding
      // AND the trailing property access (["analytics", "name"]), so resolvedPath is the leaf value.
      directTarget = resolvedPath;
    } else {
      return;
    }
  }
  const resolved = resolveNodeValue(directTarget ?? propagation.targetNode, checker, context, new Set(), evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
  for (const value of resolved.values) {
    const normalized = normalizeEventName(value);
    if (normalized) {
      events.add(normalized);
    } else {
      recordRejectedName(call, callSiteExpression(call)!.getText(), value, eventNameRejection(value)!, rejectedNames);
    }
  }
  if (resolved.dynamic) {
    recordDynamicOccurrence(call, callSiteExpression(call)!.getText(), resolved.values, dynamicOccurrences);
  }
}
