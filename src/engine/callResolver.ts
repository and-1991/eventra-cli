import ts from "typescript";

function isFunctionLike(
  node: ts.Node
): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function resolveFromSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  visited = new Set<ts.Symbol>()
): ts.FunctionLikeDeclaration | null {
  if (visited.has(symbol)) return null;
  visited.add(symbol);

  // alias unwrap
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    return resolveFromSymbol(aliased, checker, visited);
  }

  const decls = symbol.getDeclarations() ?? [];

  for (const decl of decls) {
    if (isFunctionLike(decl)) {
      return decl;
    }

    if (ts.isMethodSignature(decl)) {
      const parent = decl.parent;

      if (ts.isInterfaceDeclaration(parent) || ts.isTypeLiteralNode(parent)) {
        const name = decl.name.getText();

        const type = checker.getTypeAtLocation(parent);
        const props = type.getProperties();

        for (const prop of props) {
          if (prop.name !== name) continue;

          const resolved = resolveFromSymbol(prop, checker, visited);
          if (resolved) return resolved;
        }
      }
    }

    // fallback
    const s = checker.getSymbolAtLocation(decl);
    if (s) {
      const resolved = resolveFromSymbol(s, checker, visited);
      if (resolved) return resolved;
    }
  }

  return null;
}

export function resolveFunctionFromCall(
  expr: ts.Expression,
  checker: ts.TypeChecker
): ts.FunctionLikeDeclaration | null {
  const type = checker.getTypeAtLocation(expr);
  const signatures = type.getCallSignatures();

  for (const sig of signatures) {
    const decl = sig.getDeclaration();

    if (!decl) continue;

    if (isFunctionLike(decl)) {
      return decl;
    }

    // MethodSignature case
    if (ts.isMethodSignature(decl)) {
      const symbol = checker.getSymbolAtLocation(decl.name);

      if (symbol) {
        const resolved = resolveFromSymbol(symbol, checker);
        if (resolved) return resolved;
      }
    }
  }

  return null;
}
