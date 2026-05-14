import ts from "typescript";

import {ResolveResult} from "../resolver/resolver";

export class EvaluationCache {
  private cache = new WeakMap<ts.Symbol, ResolveResult>();

  get(symbol: ts.Symbol): ResolveResult | undefined {
    return this.cache.get(symbol);
  }

  set(symbol: ts.Symbol, result: ResolveResult): void {
    this.cache.set(symbol, result);
  }

  delete(symbol: ts.Symbol): void {
    this.cache.delete(symbol);
  }

  clear(): void {
    this.cache = new WeakMap();
  }
}
