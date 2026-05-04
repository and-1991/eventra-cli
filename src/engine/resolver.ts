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

  // PARAM MAPPING
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

  // ARRAY
  if (ts.isArrayLiteralExpression(node)) {
    const values: string[] = [];

    for (const el of node.elements) {
      const res = resolveNodeValue(el, checker, paramMap, seen);
      if (res.values.length) {
        values.push(...res.values);
      }
    }

    return {
      values: [...new Set(values)],
      dynamic: true
    };
  }

  // TEMPLATE
  if (ts.isTemplateExpression(node)) {
    let results = node.head.text ? [node.head.text] : [""];

    for (const span of node.templateSpans) {
      const res = resolveNodeValue(span.expression, checker, paramMap, seen);

      if (res.values.length) {
        results = results.flatMap(r =>
          res.values.map(v => r + v)
        );
      } else {
        results = results.map(r => r + "*");
      }

      results = results.map(r => r + span.literal.text);
    }

    return { values: results, dynamic: true };
  }

  // CONDITIONAL
  if (ts.isConditionalExpression(node)) {
    const a = resolveNodeValue(node.whenTrue, checker, paramMap, seen);
    const b = resolveNodeValue(node.whenFalse, checker, paramMap, seen);

    return {
      values: [...new Set([...a.values, ...b.values])],
      dynamic: true,
    };
  }

  // IDENTIFIER
  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return { values: [], dynamic: true };

    // INLINE FIRST
    for (const decl of symbol.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        return resolveNodeValue(
          decl.initializer,
          checker,
          paramMap,
          seen
        );
      }
    }

    // unwrap export
    symbol = resolveExportedSymbol(symbol, checker) ?? symbol;

    if (symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    for (const decl of symbol.getDeclarations() ?? []) {
      if (ts.isEnumMember(decl) && decl.initializer) {
        if (ts.isStringLiteral(decl.initializer)) {
          return {
            values: [decl.initializer.text],
            dynamic: false,
          };
        }
      }
    }

    const type = checker.getTypeAtLocation(node);

    // UNION
    if (type.isUnion()) {
      const values: string[] = [];

      for (const t of type.types) {
        if (t.flags & ts.TypeFlags.StringLiteral) {
          values.push((t as ts.StringLiteralType).value);
        }
      }

      if (values.length) {
        return { values, dynamic: false };
      }
    }

    // STRING LITERAL TYPE
    if (type.flags & ts.TypeFlags.StringLiteral) {
      return {
        values: [(type as ts.StringLiteralType).value],
        dynamic: false
      };
    }

    return { values: [], dynamic: true };
  }

  // PROPERTY ACCESS
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

    const constantValue = checker.getConstantValue(node as any);
    if (typeof constantValue === "string") {
      return { values: [constantValue], dynamic: false };
    }

    const type = checker.getTypeAtLocation(node);

    if (type.flags & ts.TypeFlags.StringLiteral) {
      return {
        values: [(type as ts.StringLiteralType).value],
        dynamic: false,
      };
    }

    // object literal resolve
    if (ts.isIdentifier(node.expression)) {
      const objSymbol = checker.getSymbolAtLocation(node.expression);

      if (objSymbol) {
        for (const decl of objSymbol.getDeclarations() ?? []) {
          if (
            ts.isVariableDeclaration(decl) &&
            decl.initializer &&
            ts.isObjectLiteralExpression(decl.initializer)
          ) {
            for (const prop of decl.initializer.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;

              const name = prop.name.getText();

              if (name === node.name.text) {
                return resolveNodeValue(
                  prop.initializer,
                  checker,
                  paramMap,
                  seen
                );
              }
            }
          }
        }
      }
    }

    // fallback
    return resolveNodeValue(node.name, checker, paramMap, seen);
  }

  // ARRAY ACCESS
  if (ts.isElementAccessExpression(node)) {
    const obj = resolveNodeValue(node.expression, checker, paramMap, seen);

    if (!node.argumentExpression) {
      return { values: obj.values, dynamic: true };
    }

    const index = resolveNodeValue(
      node.argumentExpression,
      checker,
      paramMap,
      seen
    );

    if (index.values.length === 1) {
      const i = Number(index.values[0]);

      if (!Number.isNaN(i) && obj.values[i] !== undefined) {
        return {
          values: [obj.values[i]],
          dynamic: false,
        };
      }
    }

    return obj.values.length
      ? { values: obj.values, dynamic: true }
      : { values: [], dynamic: true };
  }

  // OBJECT
  if (ts.isObjectLiteralExpression(node)) {
    const values: string[] = [];

    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;

      const name = prop.name.getText();

      if (["event", "name", "type"].includes(name)) {
        const res = resolveNodeValue(prop.initializer, checker, paramMap, seen);
        values.push(...res.values);
      }
    }

    return {
      values: [...new Set(values)],
      dynamic: true
    };
  }

  // BINARY ("btn_" + name)
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveNodeValue(node.left, checker, paramMap, seen);
      const right = resolveNodeValue(node.right, checker, paramMap, seen);

      if (!left.values.length) {
        return { values: [], dynamic: true };
      }

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

  // CALL → dynamic
  if (ts.isCallExpression(node)) {
    return { values: [], dynamic: true };
  }

  return { values: [], dynamic: true };
}
