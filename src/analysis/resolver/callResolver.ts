import ts from "typescript";

import {resolveExportedSymbol} from "./exportResolver";
import {ResolvedCallCache} from "../cache/resolvedCallCache";
import {ResolvedExportCache} from "../cache/resolvedExportCache";
import {unwrapExpression} from "../shared/utils";
import {unwrapComponentWrapper} from "../symbols/symbolUtils";

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** `return expr` statements of a function body, not looking into functions nested in it. */
function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!fn.body) {
    return [];
  }
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      found.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

const MAX_RETURN_HOPS = 4;

/**
 * The function a call hands back: `useTracker()` for `function useTracker() { return (n) => t.track(n) }`,
 * where the returned value is a function expression or a name bound to one.
 */
function resolveReturnedFunction(call: ts.CallExpression, checker: ts.TypeChecker, callCache: ResolvedCallCache, exportCache: ResolvedExportCache, hops: number): ts.FunctionLikeDeclaration | null {
  if (hops > MAX_RETURN_HOPS) {
    return null;
  }
  const factory = resolveFunctionFromCall(call.expression, checker, callCache, exportCache, hops + 1);
  if (!factory) {
    return null;
  }
  for (const returned of returnedExpressions(factory)) {
    const value = unwrapExpression(returned);
    if (isFunctionLike(value)) {
      return value;
    }
    if (ts.isIdentifier(value)) {
      for (const next of checker.getSymbolAtLocation(value)?.getDeclarations() ?? []) {
        const resolved = resolveDeclaration(next, checker);
        if (resolved) {
          return resolved;
        }
      }
    }
  }
  return null;
}

function resolveDeclaration(declaration: ts.Declaration, checker: ts.TypeChecker): ts.FunctionLikeDeclaration | null {
  // function foo() {}
  if (isFunctionLike(declaration)) {
    return declaration;
  }
  // const foo = () => {}
  if (ts.isVariableDeclaration(declaration) && declaration.initializer && isFunctionLike(declaration.initializer)) {
    return declaration.initializer;
  }
  // const Button = memo(() => {}) / forwardRef((props, ref) => {})
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const component = unwrapComponentWrapper(declaration.initializer);
    if (component) {
      return component;
    }
  }
  // class field = () => {}
  if (ts.isPropertyDeclaration(declaration) && declaration.initializer && isFunctionLike(declaration.initializer)) {
    return declaration.initializer;
  }
  // { trackFeature() {} }
  if (ts.isPropertyAssignment(declaration) && declaration.initializer && isFunctionLike(declaration.initializer)) {
    return declaration.initializer;
  }
  // `return { capture }` / `return { capture: capture }`: a hook or factory that hands back functions
  // it defined, so `analytics.capture(...)` is a call of the `capture` declared next to the return
  const target = ts.isShorthandPropertyAssignment(declaration)
    ? checker.getShorthandAssignmentValueSymbol(declaration)
    : ts.isPropertyAssignment(declaration) && ts.isIdentifier(declaration.initializer)
      ? checker.getSymbolAtLocation(declaration.initializer)
      : undefined;
  // the target is a variable, never another property, so this does not recurse into a cycle
  for (const next of target?.getDeclarations() ?? []) {
    const resolved = resolveDeclaration(next, checker);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function getExpressionSymbol(expression: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  // analytics.track()
  if (ts.isPropertyAccessExpression(expression,)) {
    return checker.getSymbolAtLocation(expression.name);
  }
  // analytics?.track()
  // A PropertyAccessChain has the exact same SyntaxKind (PropertyAccessExpression)
  // as a plain property access - the "chain" distinction is purely a flag
  // (NodeFlags.OptionalChain) on the same node kind, not a separate kind. The
  // isPropertyAccessExpression check above already matches (and returns for)
  // every property-access-chain node, so this branch can never be reached.
  /* v8 ignore next 3 */
  if (ts.isPropertyAccessChain(expression)) {
    return checker.getSymbolAtLocation(expression.name);
  }
  // analytics["track"]()
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    return checker.getSymbolAtLocation(expression.argumentExpression);
  }
  // track()
  return checker.getSymbolAtLocation(expression);
}

export function resolveFunctionFromCall(expression: ts.Expression, checker: ts.TypeChecker, callCache: ResolvedCallCache, exportCache: ResolvedExportCache, hops = 0): ts.FunctionLikeDeclaration | null {
  // useTracker()("x")
  let callee = expression;
  while (ts.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }
  if (ts.isCallExpression(callee)) {
    return resolveReturnedFunction(callee, checker, callCache, exportCache, hops);
  }
  let symbol = getExpressionSymbol(expression, checker);
  if (!symbol) {
    return null;
  }
  // export unwrap
  symbol = resolveExportedSymbol(symbol, checker, exportCache) ?? symbol;
  // alias unwrap
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  // cache
  const cached = callCache.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  // declaration resolution
  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    // const track = useTracker(); track("x")
    const resolved = resolveDeclaration(declaration, checker) ?? (
      ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)
        ? resolveReturnedFunction(declaration.initializer, checker, callCache, exportCache, hops)
        : null
    );
    if (!resolved) {
      continue;
    }
    callCache.set(symbol, resolved);
    return resolved;
  }
  // fallback:
  // type signatures

  const type = checker.getTypeOfSymbolAtLocation(symbol, declarations[0] ?? expression);
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  for (const signature of signatures) {
    const declaration = signature.declaration;
    if (declaration && isFunctionLike(declaration)) {
      callCache.set(symbol, declaration);
      return declaration;
    }
  }
  // unresolved
  callCache.set(symbol, null);
  return null;
}
