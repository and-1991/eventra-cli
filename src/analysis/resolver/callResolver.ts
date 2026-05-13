// src/analysis/resolver/callResolver.ts

import ts from "typescript";

import {
  resolveExportedSymbol,
} from "./exportResolver";

import {
  ResolvedCallCache,
} from "../cache/resolvedCallCache";

import {
  ResolvedExportCache,
} from "../cache/resolvedExportCache";

function isFunctionLike(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {

  return (
    ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
  );
}

function resolveDeclaration(
  declaration:
  ts.Declaration,
):
  | ts.FunctionLikeDeclaration
  | null {

  //
  // function foo() {}
  //

  if (
    isFunctionLike(
      declaration,
    )
  ) {

    return declaration;
  }

  //
  // const foo = () => {}
  //

  if (
    ts.isVariableDeclaration(
      declaration,
    )
    && declaration.initializer
    && isFunctionLike(
      declaration.initializer,
    )
  ) {

    return declaration.initializer;
  }

  //
  // class field = () => {}
  //

  if (
    ts.isPropertyDeclaration(
      declaration,
    )
    && declaration.initializer
    && isFunctionLike(
      declaration.initializer,
    )
  ) {

    return declaration.initializer;
  }

  return null;
}

function getExpressionSymbol(
  expression:
  ts.Expression,

  checker:
  ts.TypeChecker,
):
  | ts.Symbol
  | undefined {

  //
  // analytics.track()
  //

  if (
    ts.isPropertyAccessExpression(
      expression,
    )
  ) {

    return checker.getSymbolAtLocation(
      expression.name,
    );
  }

  //
  // analytics?.track()
  //

  if (
    ts.isPropertyAccessChain(
      expression,
    )
  ) {

    return checker.getSymbolAtLocation(
      expression.name,
    );
  }

  //
  // analytics["track"]()
  //

  if (
    ts.isElementAccessExpression(
      expression,
    )
    && expression.argumentExpression
  ) {

    return checker.getSymbolAtLocation(
      expression.argumentExpression,
    );
  }

  //
  // track()
  //

  return checker.getSymbolAtLocation(
    expression,
  );
}

export function resolveFunctionFromCall(
  expression:
  ts.Expression,

  checker:
  ts.TypeChecker,

  callCache:
  ResolvedCallCache,

  exportCache:
  ResolvedExportCache,
):
  | ts.FunctionLikeDeclaration
  | null {

  let symbol =
    getExpressionSymbol(
      expression,
      checker,
    );

  if (!symbol) {

    return null;
  }

  //
  // export unwrap
  //

  symbol =
    resolveExportedSymbol(
      symbol,
      checker,
      exportCache,
    )
    ?? symbol;

  //
  // alias unwrap
  //

  if (
    symbol.flags
    & ts.SymbolFlags.Alias
  ) {

    symbol =
      checker.getAliasedSymbol(
        symbol,
      );
  }

  //
  // cache
  //

  const cached =
    callCache.get(
      symbol,
    );

  if (
    cached !== undefined
  ) {

    return cached;
  }

  //
  // declaration resolution
  //

  const declarations =
    symbol.getDeclarations()
    ?? [];

  for (
    const declaration
    of declarations
    ) {

    const resolved =
      resolveDeclaration(
        declaration,
      );

    if (!resolved) {

      continue;
    }

    callCache.set(
      symbol,
      resolved,
    );

    return resolved;
  }

  //
  // fallback:
  // type signatures
  //

  const type =
    checker.getTypeOfSymbolAtLocation(
      symbol,
      declarations[0]
      ?? expression,
    );

  const signatures =
    checker.getSignaturesOfType(
      type,
      ts.SignatureKind.Call,
    );

  for (
    const signature
    of signatures
    ) {

    const declaration =
      signature.declaration;

    if (
      declaration
      && isFunctionLike(
        declaration,
      )
    ) {

      callCache.set(
        symbol,
        declaration,
      );

      return declaration;
    }
  }

  //
  // unresolved
  //

  callCache.set(
    symbol,
    null,
  );

  return null;
}
