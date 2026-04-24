import { Node, ts } from "ts-morph";

export type ResolveResult = {
  values: string[];
  dynamic: boolean;
};

export function resolveNodeValue(
  node: Node,
  checker: ts.TypeChecker
): ResolveResult | null {

  if (Node.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node.compilerNode);
    if (!symbol) return null;

    const decls = symbol.getDeclarations() ?? [];

    for (const d of decls) {

      if (ts.isVariableDeclaration(d) && d.initializer) {
        if (Node.isStringLiteral(d.initializer as any)) {
          return {
            values: [(d.initializer as any).text],
            dynamic: false
          };
        }
      }

      if (ts.isParameter(d) && d.initializer) {
        if (Node.isStringLiteral(d.initializer as any)) {
          return {
            values: [(d.initializer as any).text],
            dynamic: false
          };
        }
      }
    }
  }

  return null;
}
