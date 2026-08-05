// src/analysis/shared/utils.ts

import ts from "typescript";

// track(payload?.event as string)
// track((payload.event))
// track(payload!.event)
export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

// payload.event -> "event"
// payload["event"] -> "event"
export function getPropertyName(node: ts.PropertyAccessExpression | ts.PropertyAccessChain | ts.ElementAccessExpression): string | null {
  if (ts.isElementAccessExpression(node)) {
    if (!node.argumentExpression || !ts.isStringLiteral(node.argumentExpression)) {
      return null;
    }
    return node.argumentExpression.text;
  }
  return node.name.text;
}

export function getCallName(
  expression:
  ts.Expression,
): string {

  //
  // track()
  //

  if (
    ts.isIdentifier(
      expression,
    )
  ) {

    return expression.text;
  }

  //
  // analytics.track()
  // analytics?.track()
  //
  // ts.isPropertyAccessExpression is also true for a PropertyAccessChain
  // (optional-chain access is the same SyntaxKind with questionDotToken set),
  // so there is no separate isPropertyAccessChain case to handle here.

  if (
    ts.isPropertyAccessExpression(
      expression,
    )
  ) {

    return expression.name.text;
  }

  return "";
}

export function getFunctionName(
  node:
  ts.FunctionLikeDeclaration,
): string {

  //
  // function foo()
  //

  if (
    ts.isFunctionDeclaration(
      node,
    )
    && node.name
  ) {

    return node.name.text;
  }

  //
  // class method()
  //

  if (
    ts.isMethodDeclaration(
      node,
    )
    && ts.isIdentifier(
      node.name,
    )
  ) {

    return node.name.text;
  }

  //
  // const foo = () => {}
  //

  const parent =
    node.parent;

  if (
    ts.isVariableDeclaration(
      parent,
    )
    && ts.isIdentifier(
      parent.name,
    )
  ) {

    return parent.name.text;
  }

  //
  // class field = () => {}
  //

  if (
    ts.isPropertyDeclaration(
      parent,
    )
    && ts.isIdentifier(
      parent.name,
    )
  ) {

    return parent.name.text;
  }

  return "anonymous";
}
