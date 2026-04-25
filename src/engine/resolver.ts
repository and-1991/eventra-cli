import ts from "typescript";

export type ResolveResult = {
  values: string[];
  dynamic: boolean;
};

export function resolveNodeValue(
  node: ts.Node,
  checker: ts.TypeChecker
): ResolveResult | null {

  if (ts.isStringLiteral(node)) {
    return { values: [node.text], dynamic: false };
  }

  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;

    for (const span of node.templateSpans) {
      result += "*";
      result += span.literal.text;
    }

    return { values: [result], dynamic: true };
  }

  if (ts.isConditionalExpression(node)) {
    const a = resolveNodeValue(node.whenTrue, checker);
    const b = resolveNodeValue(node.whenFalse, checker);

    return {
      values: [...new Set([...(a?.values ?? []), ...(b?.values ?? [])])],
      dynamic: true,
    };
  }

  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return null;

    if (symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    for (const decl of symbol.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        return resolveNodeValue(decl.initializer, checker);
      }

      if (ts.isEnumMember(decl) && decl.initializer) {
        if (ts.isStringLiteral(decl.initializer)) {
          return {
            values: [decl.initializer.text],
            dynamic: false,
          };
        }
      }
    }
  }

  if (ts.isPropertyAccessExpression(node)) {
    const symbol = checker.getSymbolAtLocation(node);

    if (symbol) {
      let s = symbol;

      if (s.flags & ts.SymbolFlags.Alias) {
        s = checker.getAliasedSymbol(s);
      }

      for (const decl of s.getDeclarations() ?? []) {
        if (ts.isEnumMember(decl) && decl.initializer) {
          if (ts.isStringLiteral(decl.initializer)) {
            return {
              values: [decl.initializer.text],
              dynamic: false,
            };
          }
        }
      }
    }
  }

  return null;
}
