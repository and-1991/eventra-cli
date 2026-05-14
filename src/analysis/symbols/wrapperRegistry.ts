import ts from "typescript";

import {resolveExportedSymbol} from "../resolver/exportResolver";
import {ResolvedExportCache} from "../cache/resolvedExportCache";
import {WrapperSemanticInfo} from "../shared/propagation";

function isSymbol(value: ts.Symbol | ts.FunctionLikeDeclaration,): value is ts.Symbol {
  return "flags" in value;
}

export class WrapperRegistry {
  private wrappers = new WeakMap<ts.Symbol, WrapperSemanticInfo>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly exportCache: ResolvedExportCache,
  ) {
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

    let symbol: ts.Symbol | undefined;
    if (ts.isFunctionDeclaration(target) && target.name) {
      symbol = this.checker.getSymbolAtLocation(target.name);
    } else if (ts.isMethodDeclaration(target) && ts.isIdentifier(target.name)) {
      symbol = this.checker.getSymbolAtLocation(target.name);
    } else if (target.parent && ts.isVariableDeclaration(target.parent) && ts.isIdentifier(target.parent.name)) {
      symbol = this.checker.getSymbolAtLocation(target.parent.name);
    }
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
