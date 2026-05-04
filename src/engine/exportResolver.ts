import ts from "typescript";

function isRealDeclaration(node: ts.Node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isClassDeclaration(node)
  );
}

export function resolveExportedSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  visited = new Set<ts.Symbol>()
): ts.Symbol | null {

  if (visited.has(symbol)) return null;
  visited.add(symbol);

  // unwrap alias
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    return resolveExportedSymbol(aliased, checker, visited);
  }

  // export symbol
  const exportSymbol = checker.getExportSymbolOfSymbol(symbol);
  if (exportSymbol && exportSymbol !== symbol) {
    return resolveExportedSymbol(exportSymbol, checker, visited);
  }

  const decls = symbol.getDeclarations() ?? [];

  if (decls.some(isRealDeclaration)) {
    return symbol;
  }

  // exports (re-export)
  for (const decl of decls) {
    const source = decl.getSourceFile();
    const moduleSymbol = (source as any).symbol;

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
