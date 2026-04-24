import { Node } from "ts-morph";

export function resolveFunctionFromCall(expr: Node) {
  let symbol = expr.getSymbol();

  if (!symbol && Node.isPropertyAccessExpression(expr)) {
    symbol = expr.getNameNode().getSymbol();
  }

  if (!symbol) return null;

  const decls = symbol.getDeclarations() ?? [];

  for (const d of decls) {
    if (Node.isFunctionDeclaration(d)) return d;

    if (Node.isVariableDeclaration(d)) {
      const init = d.getInitializer();

      if (
        init &&
        (Node.isArrowFunction(init) ||
          Node.isFunctionExpression(init))
      ) {
        return init;
      }
    }

    if (Node.isMethodDeclaration(d)) return d;

    if (Node.isFunctionExpression(d) || Node.isArrowFunction(d)) {
      return d;
    }
  }

  return null;
}
