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
  visited = new Set<ts.Symbol>(),
  depth = 0
): ts.FunctionLikeDeclaration | null {
  if (visited.has(symbol)) return null;
  if (depth > 5) return null;

  visited.add(symbol);

  // unwrap alias
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    return resolveFromSymbol(aliased, checker, visited, depth + 1);
  }

  // re-export support
  if ((symbol as any).exports) {
    for (const exp of (symbol as any).exports.values()) {
      const resolved = resolveFromSymbol(exp, checker, visited, depth + 1);
      if (resolved) return resolved;
    }
  }

  const decls = symbol.getDeclarations() ?? [];

  for (const decl of decls) {
    // direct function
    if (isFunctionLike(decl)) {
      return decl;
    }

    // VARIABLE → FUNCTION
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

    // MethodSignature (interface / type)
    if (ts.isMethodSignature(decl)) {
      const parent = decl.parent;

      if (
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeLiteralNode(parent)
      ) {
        const name = decl.name.getText();

        const type = checker.getTypeAtLocation(parent);
        const props = type.getProperties();

        for (const prop of props) {
          if (prop.name !== name) continue;

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
    const s = checker.getSymbolAtLocation(decl);
    if (s && s !== symbol) {
      const resolved = resolveFromSymbol(
        s,
        checker,
        visited,
        depth + 1
      );
      if (resolved) return resolved;
    }
  }

  return null;
}

export function resolveFunctionFromCall(
  expr: ts.Expression,
  checker: ts.TypeChecker
): ts.FunctionLikeDeclaration | null {

  // tracker.track
  if (ts.isPropertyAccessExpression(expr)) {
    let symbol = checker.getSymbolAtLocation(expr.name);

    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    if (symbol) {
      const resolved = resolveFromSymbol(symbol, checker);
      if (resolved) return resolved;
    }
  }

  // tracker["track"]
  if (ts.isElementAccessExpression(expr)) {
    const symbol = checker.getSymbolAtLocation(expr.argumentExpression);

    if (symbol) {
      const resolved = resolveFromSymbol(symbol, checker);
      if (resolved) return resolved;
    }
  }

  // normal call signatures
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

  // fallback
  const symbol = checker.getSymbolAtLocation(expr);
  if (symbol) {
    return resolveFromSymbol(symbol, checker);
  }

  return null;
}
