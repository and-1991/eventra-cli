import ts from "typescript";

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
  return undefined;
}
