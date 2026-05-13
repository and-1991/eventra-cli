// src/analysis/cache/resolvedExportCache.ts

import ts from "typescript";

export class ResolvedExportCache {

  private cache =
    new WeakMap<
      ts.Symbol,
      ts.Symbol
      | null
    >();

  get(
    symbol: ts.Symbol,
  ):
    | ts.Symbol
    | null
    | undefined {

    return this.cache.get(
      symbol,
    );
  }

  set(
    symbol: ts.Symbol,

    resolved:
      ts.Symbol
      | null,
  ): void {

    this.cache.set(
      symbol,
      resolved,
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
