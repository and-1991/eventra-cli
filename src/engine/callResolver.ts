import ts from "typescript";

function isFn(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function resolveFromSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>()
): ts.FunctionLikeDeclaration | null {
  if (seen.has(symbol)) return null;
  seen.add(symbol);

  if (symbol.flags & ts.SymbolFlags.Alias) {
    return resolveFromSymbol(checker.getAliasedSymbol(symbol), checker, seen);
  }

  for (const d of symbol.getDeclarations() ?? []) {
    if (isFn(d)) return d;

    if (ts.isVariableDeclaration(d) && d.initializer) {
      if (isFn(d.initializer)) return d.initializer;

      const s = checker.getSymbolAtLocation(d.initializer);
      if (s) {
        const r = resolveFromSymbol(s, checker, seen);
        if (r) return r;
      }
    }
  }

  return null;
}

export function resolveFunctionFromCall(
  expr: ts.Expression,
  checker: ts.TypeChecker
): ts.FunctionLikeDeclaration | null {
  // foo.bar()
  if (ts.isPropertyAccessExpression(expr)) {
    const s = checker.getSymbolAtLocation(expr.name);
    if (s) {
      const r = resolveFromSymbol(s, checker);
      if (r) return r;
    }
  }

  // direct call
  const type = checker.getTypeAtLocation(expr);
  for (const sig of type.getCallSignatures()) {
    const d = sig.getDeclaration();
    if (d && isFn(d)) return d;
  }

  const s = checker.getSymbolAtLocation(expr);
  if (s) return resolveFromSymbol(s, checker);

  return null;
}
