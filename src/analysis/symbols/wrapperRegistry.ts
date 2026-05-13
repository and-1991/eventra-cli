import ts from "typescript";

import {
  resolveExportedSymbol,
} from "../resolver/exportResolver";

import {
  ResolvedExportCache,
} from "../cache/resolvedExportCache";

import {
  WrapperSemanticInfo,
} from "../shared/propagation";

function isSymbol(
  value:
    ts.Symbol
    | ts.FunctionLikeDeclaration,
): value is ts.Symbol {

  return "flags" in value;
}

export class WrapperRegistry {

  private wrappers =
    new WeakMap<
      ts.Symbol,
      WrapperSemanticInfo
    >();

  private normalize(
    symbol: ts.Symbol,

    checker: ts.TypeChecker,

    exportCache:
    ResolvedExportCache,
  ): ts.Symbol {

    return (
      resolveExportedSymbol(
        symbol,
        checker,
        exportCache,
      )
      ?? symbol
    );
  }

  set(
    semantic:
    WrapperSemanticInfo,

    checker:
    ts.TypeChecker,

    exportCache:
    ResolvedExportCache,
  ): void {

    this.wrappers.set(

      this.normalize(
        semantic.symbol,
        checker,
        exportCache,
      ),

      semantic,
    );
  }

  get(
    target:
      ts.Symbol
      | ts.FunctionLikeDeclaration,

    checker:
    ts.TypeChecker,

    exportCache:
    ResolvedExportCache,
  ):
    | WrapperSemanticInfo
    | undefined {

    if (
      isSymbol(target)
    ) {

      return this.wrappers.get(

        this.normalize(
          target,
          checker,
          exportCache,
        ),
      );
    }

    let symbol:
      ts.Symbol
      | undefined;

    if (
      ts.isFunctionDeclaration(target)
      && target.name
    ) {

      symbol =
        checker.getSymbolAtLocation(
          target.name,
        );
    }

    else if (
      ts.isMethodDeclaration(target)
      && ts.isIdentifier(
        target.name,
      )
    ) {

      symbol =
        checker.getSymbolAtLocation(
          target.name,
        );
    }

    else if (
      target.parent
      && ts.isVariableDeclaration(
        target.parent,
      )
      && ts.isIdentifier(
        target.parent.name,
      )
    ) {

      symbol =
        checker.getSymbolAtLocation(
          target.parent.name,
        );
    }

    if (!symbol) {

      return undefined;
    }

    return this.wrappers.get(

      this.normalize(
        symbol,
        checker,
        exportCache,
      ),
    );
  }

  has(
    symbol:
    ts.Symbol,

    checker:
    ts.TypeChecker,

    exportCache:
    ResolvedExportCache,
  ): boolean {

    return this.wrappers.has(

      this.normalize(
        symbol,
        checker,
        exportCache,
      ),
    );
  }

  clear():
    void {

    this.wrappers =
      new WeakMap();
  }
}
