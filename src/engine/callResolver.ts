import ts from "typescript";

export function resolveFunctionFromCall(
  expr: ts.Expression,
  checker: ts.TypeChecker
): ts.FunctionLikeDeclaration | null {

  let symbol = checker.getSymbolAtLocation(expr);

  if (!symbol && ts.isPropertyAccessExpression(expr)) {
    symbol = checker.getSymbolAtLocation(expr.name);
  }

  if (!symbol) return null;

  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }

  for (const decl of symbol.getDeclarations() ?? []) {
    if (
      ts.isFunctionDeclaration(decl) ||
      ts.isMethodDeclaration(decl) ||
      ts.isFunctionExpression(decl) ||
      ts.isArrowFunction(decl)
    ) {
      return decl;
    }

    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = decl.initializer;

      if (
        ts.isArrowFunction(init) ||
        ts.isFunctionExpression(init)
      ) {
        return init;
      }
    }
  }

  return null;
}
