import ts from "typescript";

// HELPERS
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

// symbol → function
function resolveFromSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  visited = new Set<ts.Symbol>(),
  depth = 0
): ts.FunctionLikeDeclaration | null {
  if (!symbol) return null;
  if (visited.has(symbol)) return null;
  if (depth > 10) return null;

  visited.add(symbol);

  // Alias unwrap (import/export)
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      const aliased = checker.getAliasedSymbol(symbol);
      return resolveFromSymbol(aliased, checker, visited, depth + 1);
    } catch {}
  }

  // Declarations
  const decls = symbol.getDeclarations() ?? [];

  for (const decl of decls) {
    /**
     * direct function
     */
    if (isFunctionLike(decl)) {
      return decl;
    }

    // VARIABLE → FUNCTION const fn = () => {}
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      if (isFunctionLike(decl.initializer)) {
        return decl.initializer;
      }

      const innerSymbol = checker.getSymbolAtLocation(decl.initializer);
      if (innerSymbol && innerSymbol !== symbol) {
        const resolved = resolveFromSymbol(
          innerSymbol,
          checker,
          visited,
          depth + 1
        );
        if (resolved) return resolved;
      }
    }

    // CLASS METHOD
    if (ts.isMethodDeclaration(decl)) {
      return decl;
    }

    // interface / type method
    if (ts.isMethodSignature(decl)) {
      const parent = decl.parent;

      if (
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeLiteralNode(parent)
      ) {
        const type = checker.getTypeAtLocation(parent);
        const props = type.getProperties();

        for (const prop of props) {
          const resolved = resolveFromSymbol(
            prop,
            checker,
            visited,
            depth + 1
          );
          if (resolved) return resolved;
        }
      }
    }

    // fallback recursion
    const inner = checker.getSymbolAtLocation(decl);
    if (inner && inner !== symbol) {
      const resolved = resolveFromSymbol(
        inner,
        checker,
        visited,
        depth + 1
      );
      if (resolved) return resolved;
    }
  }

  // Exports (re-export)
  const exports = (symbol as any).exports;
  if (exports) {
    for (const exp of exports.values()) {
      const resolved = resolveFromSymbol(
        exp,
        checker,
        visited,
        depth + 1
      );
      if (resolved) return resolved;
    }
  }

  return null;
}

// MAIN FUNCTION
export function resolveFunctionFromCall(
  expr: ts.Expression,
  checker: ts.TypeChecker
): ts.FunctionLikeDeclaration | null {
  // obj.method()
  if (ts.isPropertyAccessExpression(expr)) {
    let symbol = checker.getSymbolAtLocation(expr.name);

    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {}
    }

    if (symbol) {
      const resolved = resolveFromSymbol(symbol, checker);
      if (resolved) return resolved;
    }
  }

  // obj["method"]()
  if (ts.isElementAccessExpression(expr)) {
    const symbol = checker.getSymbolAtLocation(expr.argumentExpression);

    if (symbol) {
      const resolved = resolveFromSymbol(symbol, checker);
      if (resolved) return resolved;
    }
  }

  // Call signatures
  const type = checker.getTypeAtLocation(expr);
  const signatures = type.getCallSignatures();

  for (const sig of signatures) {
    const decl = sig.getDeclaration();
    if (!decl) continue;

    if (isFunctionLike(decl)) {
      return decl;
    }

    if (ts.isMethodSignature(decl)) {
      const symbol = checker.getSymbolAtLocation(decl.name);

      if (symbol) {
        const resolved = resolveFromSymbol(symbol, checker);
        if (resolved) return resolved;
      }
    }
  }

  // Identifier fallback
  if (ts.isIdentifier(expr)) {
    let symbol = checker.getSymbolAtLocation(expr);

    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {}
    }

    if (symbol) {
      const resolved = resolveFromSymbol(symbol, checker);
      if (resolved) return resolved;
    }
  }

  // LAST fallback
  const symbol = checker.getSymbolAtLocation(expr);
  if (symbol) {
    return resolveFromSymbol(symbol, checker);
  }

  return null;
}
