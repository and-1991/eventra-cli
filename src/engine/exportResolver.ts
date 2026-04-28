import ts from "typescript";

export function resolveExportedSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  visited = new Set<ts.Symbol>()
): ts.Symbol | null {

  if (visited.has(symbol)) return null;
  visited.add(symbol);
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    return resolveExportedSymbol(aliased, checker, visited);
  }

  if (symbol.getDeclarations()?.length) {
    return symbol;
  }

  const declarations = symbol.getDeclarations() ?? [];

  for (const decl of declarations) {
    const source = decl.getSourceFile();
    const moduleSymbol = checker.getSymbolAtLocation(source);

    if (!moduleSymbol) continue;

    const exports = checker.getExportsOfModule(moduleSymbol);

    for (const exp of exports) {
      const resolved = resolveExportedSymbol(exp, checker, visited);
      if (resolved?.getDeclarations()?.length) {
        return resolved;
      }
    }
  }

  return symbol;
}
