import ts from "typescript";

import {resolveExportedSymbol} from "../resolver/exportResolver";
import {ResolvedExportCache} from "../cache/resolvedExportCache";
import {WrapperSemanticInfo} from "../shared/propagation";
import {getFunctionSymbol} from "./symbolUtils";

function isSymbol(value: ts.Symbol | ts.FunctionLikeDeclaration): value is ts.Symbol {
  return typeof (value as ts.Symbol).getDeclarations === "function";
}

export class WrapperRegistry {
  private wrappers = new WeakMap<ts.Symbol, WrapperSemanticInfo>();

  private resolvedChecker: ts.TypeChecker | undefined;

  /** `checker` may be a provider, called once on first use (setChecker replaces it). */
  constructor(
    private pendingChecker: ts.TypeChecker | (() => ts.TypeChecker),
    private readonly exportCache: ResolvedExportCache,
  ) {}

  setChecker(checker: ts.TypeChecker): void {
    this.resolvedChecker = checker;
  }

  getChecker(): ts.TypeChecker {
    if (!this.resolvedChecker) {
      this.resolvedChecker =
        typeof this.pendingChecker === "function" ? this.pendingChecker() : this.pendingChecker;
    }
    return this.resolvedChecker;
  }

  private get checker(): ts.TypeChecker {
    return this.getChecker();
  }

  private normalize(symbol: ts.Symbol): ts.Symbol {
    return (
      resolveExportedSymbol(symbol, this.checker, this.exportCache) ?? symbol
    );
  }

  set(semantic: WrapperSemanticInfo): void {
    this.wrappers.set(this.normalize(semantic.symbol), semantic);
  }

  get(target: ts.Symbol | ts.FunctionLikeDeclaration): WrapperSemanticInfo | undefined {
    if (isSymbol(target)) {
      return this.wrappers.get(this.normalize(target));
    }

    const symbol = getFunctionSymbol(target, this.checker);
    if (!symbol) {
      return undefined;
    }
    return this.wrappers.get(this.normalize(symbol));
  }

  has(symbol: ts.Symbol): boolean {
    return this.wrappers.has(this.normalize(symbol));
  }

  delete(symbol: ts.Symbol): void {
    this.wrappers.delete(this.normalize(symbol));
  }

  clear(): void {
    this.wrappers = new WeakMap();
  }
}
