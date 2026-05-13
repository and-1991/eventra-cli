// src/analysis/cache/resolvedCallCache.ts

import ts from "typescript";

export class ResolvedCallCache {

  private cache =
    new WeakMap<
      ts.Symbol,
      ts.FunctionLikeDeclaration
      | null
    >();

  get(
    symbol: ts.Symbol,
  ):
    | ts.FunctionLikeDeclaration
    | null
    | undefined {

    return this.cache.get(
      symbol,
    );
  }

  set(
    symbol: ts.Symbol,

    value:
      ts.FunctionLikeDeclaration
      | null,
  ): void {

    this.cache.set(
      symbol,
      value,
    );
  }

  delete(
    symbol: ts.Symbol,
  ): void {

    this.cache.delete(
      symbol,
    );
  }

  clear():
    void {

    this.cache =
      new WeakMap();
  }
}
