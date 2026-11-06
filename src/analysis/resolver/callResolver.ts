import ts from "typescript";

import {resolveExportedSymbol} from "./exportResolver";
import {ResolvedCallCache} from "../cache/resolvedCallCache";
import {ResolvedExportCache} from "../cache/resolvedExportCache";
import {unwrapExpression} from "../shared/utils";
import {renderMethodOf} from "../symbols/classComponent";
import {hookMemoValue, hookProvidedFunction, unwrapComponentWrapper, unwrapHookCallback} from "../symbols/symbolUtils";

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
    const value = unwrapHookCallback(returned);
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

/**
 * The object literal an expression stands for: itself, the value a `useMemo` factory returns, or a name bound to one.
 * Read from the code, so it works when the types behind a hook (`react` not installed) are lost.
 */
function objectLiteralOf(expression: ts.Expression, checker: ts.TypeChecker, hops = 0): ts.ObjectLiteralExpression | null {
  if (hops > MAX_RETURN_HOPS) {
    return null;
  }
  const value = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(value)) {
    return value;
  }
  const memoValue = hookMemoValue(value);
  if (memoValue) {
    return objectLiteralOf(memoValue, checker, hops + 1);
  }
  if (ts.isIdentifier(value)) {
    for (const declaration of checker.getSymbolAtLocation(value)?.getDeclarations() ?? []) {
      const literal = ts.isVariableDeclaration(declaration) && declaration.initializer ? objectLiteralOf(declaration.initializer, checker, hops + 1) : null;
      if (literal) {
        return literal;
      }
    }
  }
  return null;
}

/** The call an expression is the result of: the call itself, or a name set from one (`const api = useApi()`). */
function callBehind(expression: ts.Expression, checker: ts.TypeChecker): ts.CallExpression | null {
  const value = unwrapExpression(expression);
  if (ts.isCallExpression(value)) {
    return value;
  }
  if (ts.isIdentifier(value)) {
    for (const declaration of checker.getSymbolAtLocation(value)?.getDeclarations() ?? []) {
      const init = ts.isVariableDeclaration(declaration) && declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;
      if (init && ts.isCallExpression(init)) {
        return init;
      }
    }
  }
  return null;
}

/**
 * `useTrack().track`, `const api = useTrack(); api.track` and `const { track } = useTrack()`: the member `name` of the
 * object a hook or factory returns, read from the returned object literal.
 */
function resolveMemberOfResult(receiver: ts.Expression, name: string, checker: ts.TypeChecker, callCache: ResolvedCallCache, exportCache: ResolvedExportCache, hops: number): ts.FunctionLikeDeclaration | null {
  const call = callBehind(receiver, checker);
  const factory = call && hops <= MAX_RETURN_HOPS ? resolveFunctionFromCall(call.expression, checker, callCache, exportCache, hops + 1) : null;
  for (const returned of factory ? returnedExpressions(factory) : []) {
    for (const property of objectLiteralOf(returned, checker)?.properties ?? []) {
      const isMember = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property);
      if (isMember && ts.isIdentifier(property.name) && property.name.text === name) {
        const resolved = resolveDeclaration(property, checker);
        if (resolved) {
          return resolved;
        }
      }
    }
  }
  return null;
}

/** `const { track } = useTrack()` / `const { track: send } = useTrack()`: the member the binding takes from a call result. */
function resolveBinding(declaration: ts.BindingElement, checker: ts.TypeChecker, callCache: ResolvedCallCache, exportCache: ResolvedExportCache, hops: number): ts.FunctionLikeDeclaration | null {
  const pattern = declaration.parent;
  const holder = pattern.parent;
  const member = declaration.propertyName ?? declaration.name;
  if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(holder) || !holder.initializer || !ts.isIdentifier(member)) {
    return null;
  }
  return resolveMemberOfResult(holder.initializer, member.text, checker, callCache, exportCache, hops);
}

function resolveDeclaration(declaration: ts.Declaration, checker: ts.TypeChecker): ts.FunctionLikeDeclaration | null {
  // class Button extends Component { render() {} }: <Button /> renders it, so its props reach render()
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    return renderMethodOf(declaration);
  }
  // function foo() {}
  if (isFunctionLike(declaration)) {
    return declaration;
  }
  // const foo = () => {}
  if (ts.isVariableDeclaration(declaration) && declaration.initializer && isFunctionLike(declaration.initializer)) {
    return declaration.initializer;
  }
  // const foo = useCallback((n) => ..., []) / useMemo(() => (n) => ..., []): the function the hook hands back
  const provided = ts.isVariableDeclaration(declaration) && declaration.initializer ? hookProvidedFunction(declaration.initializer) : null;
  if (provided) {
    return provided;
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
  // { track: useCallback((n) => ..., []) }: a member that holds the function a hook hands back
  const providedMember = ts.isPropertyAssignment(declaration) ? hookProvidedFunction(declaration.initializer) : null;
  if (providedMember) {
    return providedMember;
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
    // `useTrack().track(...)` when the type of the result is lost: read the member from the code
    const access = ts.isPropertyAccessExpression(expression) ? expression : null;
    return access ? resolveMemberOfResult(access.expression, access.name.text, checker, callCache, exportCache, hops) : null;
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
        : ts.isBindingElement(declaration)
          ? resolveBinding(declaration, checker, callCache, exportCache, hops)
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
