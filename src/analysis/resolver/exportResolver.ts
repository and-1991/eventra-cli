import ts from "typescript";

import {ResolvedExportCache} from "../cache/resolvedExportCache";

function isConcreteDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node)
    || ts.isVariableDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isEnumDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isPropertyDeclaration(node)
  );
}

export function resolveExportedSymbol(symbol: ts.Symbol, checker: ts.TypeChecker, cache: ResolvedExportCache, visited?: Set<ts.Symbol>): ts.Symbol | null {
  const seen = visited ?? new Set<ts.Symbol>();
  const cached = cache.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  // cycle guard
  if (seen.has(symbol)) {
    cache.set(symbol, null);
    return null;
  }
  seen.add(symbol);
  // alias unwrap
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol,);
    const resolved = resolveExportedSymbol(aliased, checker, cache, seen);
    cache.set(symbol, resolved);
    return resolved;
  }
  // export unwrap
  const exportSymbol = checker.getExportSymbolOfSymbol(symbol);
  if (exportSymbol && exportSymbol !== symbol) {
    const resolved = resolveExportedSymbol(exportSymbol, checker, cache, seen);
    cache.set(symbol, resolved);
    return resolved;
  }
  // declaration existence
  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (isConcreteDeclaration(declaration)) {
      cache.set(symbol, symbol);
      return symbol;
    }
  }
  // final validation
  const valid = declarations.some(isConcreteDeclaration);
  if (valid) {
    cache.set(symbol, symbol);
    return symbol;
  }
  cache.set(symbol, null);
  return null;
}
