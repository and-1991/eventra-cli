import ts from "typescript";
import { resolveExportedSymbol } from "./exportResolver";

export type ResolveResult = {
  values: string[];
  dynamic: boolean;
};

export function resolveNodeValue(
  node: ts.Node,
  checker: ts.TypeChecker,
  paramMap?: Map<string, ts.Expression>,
  seen = new Set<ts.Node>()
): ResolveResult {
  if (seen.has(node)) {
    return { values: [], dynamic: true };
  }
  seen.add(node);

  // PARAM MAP (wrapper args)
  if (ts.isIdentifier(node) && paramMap?.has(node.text)) {
    return resolveNodeValue(
      paramMap.get(node.text)!,
      checker,
      paramMap,
      seen
    );
  }

  // STRING
  if (ts.isStringLiteral(node)) {
    return { values: [node.text], dynamic: false };
  }

  // TEMPLATE
  if (ts.isTemplateExpression(node)) {
    let results = node.head.text ? [node.head.text] : [""];

    for (const span of node.templateSpans) {
      const res = resolveNodeValue(
        span.expression,
        checker,
        paramMap,
        seen
      );

      results = results.flatMap(r =>
        res.values.length
          ? res.values.map(v => r + v)
          : [r + "*"]
      );

      results = results.map(r => r + span.literal.text);
    }

    return { values: results, dynamic: true };
  }

  // CONDITIONAL (a ? b : c)
  if (ts.isConditionalExpression(node)) {
    const a = resolveNodeValue(node.whenTrue, checker, paramMap, seen);
    const b = resolveNodeValue(node.whenFalse, checker, paramMap, seen);

    return {
      values: [...new Set([...a.values, ...b.values])],
      dynamic: true,
    };
  }

  // OBJECT → берём ВСЕ значения (без привязки к ключам)
  if (ts.isObjectLiteralExpression(node)) {
    const values: string[] = [];

    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;

      const res = resolveNodeValue(
        prop.initializer,
        checker,
        paramMap,
        seen
      );

      values.push(...res.values);
    }

    return {
      values: [...new Set(values)],
      dynamic: true,
    };
  }

  // ARRAY
  if (ts.isArrayLiteralExpression(node)) {
    const values: string[] = [];

    for (const el of node.elements) {
      const res = resolveNodeValue(el, checker, paramMap, seen);
      values.push(...res.values);
    }

    return {
      values: [...new Set(values)],
      dynamic: true,
    };
  }

  // BINARY CONCAT
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveNodeValue(node.left, checker, paramMap, seen);
      const right = resolveNodeValue(node.right, checker, paramMap, seen);

      return {
        values: left.values.flatMap(l =>
          right.values.length
            ? right.values.map(r => l + r)
            : [l + "*"]
        ),
        dynamic: true,
      };
    }
  }

  // IDENTIFIER
  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return { values: [], dynamic: true };

    symbol = resolveExportedSymbol(symbol, checker) ?? symbol;

    // const VAR = "click"
    for (const decl of symbol.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        return resolveNodeValue(
          decl.initializer,
          checker,
          paramMap,
          seen
        );
      }

      // enum
      if (ts.isEnumMember(decl) && decl.initializer) {
        if (ts.isStringLiteral(decl.initializer)) {
          return {
            values: [decl.initializer.text],
            dynamic: false,
          };
        }
      }
    }

    return { values: [], dynamic: true };
  }

  // PROPERTY ACCESS (ENUM / CONST)
  if (ts.isPropertyAccessExpression(node)) {
    const symbol = checker.getSymbolAtLocation(node);

    if (symbol) {
      let s = resolveExportedSymbol(symbol, checker) ?? symbol;

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

    return { values: [], dynamic: true };
  }

  // CALL → unwrap args
  if (ts.isCallExpression(node)) {
    const values: string[] = [];

    for (const arg of node.arguments) {
      const res = resolveNodeValue(arg, checker, paramMap, seen);
      values.push(...res.values);
    }

    return values.length
      ? { values, dynamic: true }
      : { values: [], dynamic: true };
  }

  return { values: [], dynamic: true };
}
