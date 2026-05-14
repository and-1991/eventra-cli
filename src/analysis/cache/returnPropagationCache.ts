import ts from "typescript";

import {ReturnSemanticInfo} from "../shared/returnPropagation";

export class ReturnPropagationCache {
  private cache = new WeakMap<ts.FunctionLikeDeclaration, ReturnSemanticInfo | null>();

  get(declaration: ts.FunctionLikeDeclaration): ReturnSemanticInfo | null | undefined {
    return this.cache.get(declaration);
  }

  set(declaration: ts.FunctionLikeDeclaration, value: ReturnSemanticInfo | null): void {
    this.cache.set(declaration, value);
  }

  delete(declaration: ts.FunctionLikeDeclaration,): void {
    this.cache.delete(declaration);
  }

  clear(): void {
    this.cache = new WeakMap();
  }
}
