import ts from "typescript";
import {resolveExportedSymbol} from "./exportResolver";

export type ResolveResult = {
  values: string[];
  dynamic: boolean;
};

export function resolveNodeValue(
  node: ts.Node,
  checker: ts.TypeChecker,
  paramMap?: Map<string, ts.Expression>,
  seen = new Set<ts.Node>()
): ResolveResult | null {

  if (seen.has(node)) return null;
  seen.add(node);

  // param mapping
  if (ts.isIdentifier(node) && paramMap?.has(node.text)) {
    return resolveNodeValue(
      paramMap.get(node.text)!,
      checker,
      paramMap
    );
  }

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
    const a = resolveNodeValue(node.whenTrue, checker, paramMap, seen);
    const b = resolveNodeValue(node.whenFalse, checker, paramMap, seen);

    return {
      values: [...new Set([...(a?.values ?? []), ...(b?.values ?? [])])],
      dynamic: true,
    };
  }

  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return null;

    symbol = resolveExportedSymbol(symbol, checker) ?? symbol;

    if (symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    for (const decl of symbol.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        return resolveNodeValue(decl.initializer, checker, paramMap, seen);
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

  if (ts.isObjectLiteralExpression(node)) {
    const values: string[] = [];

    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;

      const name = prop.name.getText();

      if (name === "event") {
        const res = resolveNodeValue(prop.initializer, checker, paramMap, seen);
        if (res) values.push(...res.values);
      }
    }

    return { values, dynamic: true };
  }

  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveNodeValue(node.left, checker, paramMap, seen);
      const right = resolveNodeValue(node.right, checker, paramMap, seen);

      if (left && right) {
        return {
          values: left.values.flatMap(l =>
            right.values.map(r => l + r)
          ),
          dynamic: true,
        };
      }
    }
  }

  return null;
}
