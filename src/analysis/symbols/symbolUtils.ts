import ts from "typescript";

import { isExpressionWrapper } from "../shared/utils";

/**
 * Symbol an identifier *refers to*. For the name in a shorthand property (`{ event }`) a plain
 * `getSymbolAtLocation` yields the property's own symbol, not the variable/parameter it reads.
 */
export function getValueSymbol(node: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  const parent = node.parent;
  if (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    return checker.getShorthandAssignmentValueSymbol(parent);
  }
  return checker.getSymbolAtLocation(node);
}

export function getFunctionSymbol(node: ts.FunctionLikeDeclaration, checker: ts.TypeChecker,): ts.Symbol | undefined {
  // function foo() {}
  if (ts.isFunctionDeclaration(node) && node.name) {
    return checker.getSymbolAtLocation(node.name);
  }
  // class method() {}
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return checker.getSymbolAtLocation(node.name);
  }
  // object literal method
  // const obj = {
  //   foo() {}
  // }
  if (ts.isMethodDeclaration(node) && ts.isComputedPropertyName(node.name)) {
    return checker.getSymbolAtLocation(node.name.expression);
  }
  // const foo = () => {}
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return checker.getSymbolAtLocation(parent.name);
  }
  // class field = () => {}
  if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return checker.getSymbolAtLocation(parent.name);
  }
  // object property
  // const x = {
  //   foo: () => {}
  // }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return checker.getSymbolAtLocation(parent.name);
  }
  // export default function() {}
  if (ts.isExportAssignment(parent)) {
    return checker.getSymbolAtLocation(node);
  }
  // `return (name) => ...` / `() => (name) => ...`: a function a hook or factory hands back has no
  // name of its own, but the binder still gives it a symbol, and that is what a call of the result
  // (`const track = useTracker(); track("x")`) is matched against.
  if (isReturnedFunction(node)) {
    return (node as ts.Node & { symbol?: ts.Symbol }).symbol;
  }
  return undefined;
}

/** An arrow/function expression that is the value of a `return`, or the concise body of an arrow, possibly in parentheses, `as` or `!`. */
export function isReturnedFunction(node: ts.FunctionLikeDeclaration): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
    return false;
  }
  // `inner` is the outermost wrapper around the function, or the function itself
  let inner: ts.Node = node;
  let outer: ts.Node = node.parent;
  while (isExpressionWrapper(outer)) {
    inner = outer;
    outer = outer.parent;
  }
  return ts.isReturnStatement(outer) || (ts.isArrowFunction(outer) && outer.body === inner);
}

/**
 * The name a wrapper is reported under: its own, or for an anonymous returned function the hook that
 * returns it (`useTracker` for `function useTracker() { return (n) => t.track(n); }`).
 */
export function wrapperName(declaration: ts.FunctionLikeDeclaration, symbol: ts.Symbol): string {
  if (!isReturnedFunction(declaration)) {
    return symbol.getName();
  }
  const owner = ts.findAncestor(declaration.parent, (n): n is ts.FunctionLikeDeclaration => ts.isFunctionLike(n));
  const ownerName = owner && (owner as { name?: ts.Node }).name;
  if (ownerName && ts.isIdentifier(ownerName)) {
    return ownerName.text;
  }
  const holder = owner?.parent;
  return holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : symbol.getName();
}
