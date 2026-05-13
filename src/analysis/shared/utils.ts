// src/analysis/shared/utils.ts

import ts from "typescript";

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
  //

  if (
    ts.isPropertyAccessExpression(
      expression,
    )
  ) {

    return expression.name.text;
  }

  //
  // analytics?.track()
  //

  if (
    ts.isPropertyAccessChain(
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
