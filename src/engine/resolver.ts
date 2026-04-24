import { Node, ts } from "ts-morph";

export type ResolveResult = {
  values: string[];
  dynamic: boolean;
};

export function resolveNodeValue(
  node: Node,
  checker: ts.TypeChecker
): ResolveResult | null {
  if (!Node.isIdentifier(node)) return null;

  const symbol = checker.getSymbolAtLocation(node.compilerNode);
  if (!symbol) return null;

  const decls = symbol.getDeclarations() ?? [];

  for (const d of decls) {
    if (ts.isVariableDeclaration(d) && d.initializer) {
      const init = d.initializer;

      if (ts.isStringLiteral(init)) {
        return { values: [init.text], dynamic: false };
      }

      if (ts.isNoSubstitutionTemplateLiteral(init)) {
        return { values: [init.text], dynamic: false };
      }

      if (ts.isTemplateExpression(init)) {
        let result = init.head.text;

        for (const span of init.templateSpans) {
          result += "*";
          result += span.literal.text;
        }

        return { values: [result], dynamic: true };
      }
    }

    if (ts.isParameter(d) && d.initializer) {
      const init = d.initializer;

      if (ts.isStringLiteral(init)) {
        return { values: [init.text], dynamic: false };
      }
    }
  }

  return null;
}
