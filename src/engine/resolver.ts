import ts from "typescript";
import { resolveExportedSymbol } from "./exportResolver";
import { resolveFunctionFromCall } from "./callResolver";

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
  if (seen.has(node)) return { values: [], dynamic: true };
  seen.add(node);

  // param passthrough
  if (ts.isIdentifier(node) && paramMap?.has(node.text)) {
    return resolveNodeValue(paramMap.get(node.text)!, checker, paramMap, seen);
  }

  // string
  if (ts.isStringLiteral(node)) {
    return { values: [node.text], dynamic: false };
  }

  // template
  if (ts.isTemplateExpression(node)) {
    let results = node.head.text ? [node.head.text] : [""];
    for (const span of node.templateSpans) {
      const r = resolveNodeValue(span.expression, checker, paramMap, seen);
      results = results.flatMap(s =>
        r.values.length ? r.values.map(v => s + v) : [s + "*"]
      );
      results = results.map(s => s + span.literal.text);
    }
    return { values: results, dynamic: true };
  }

  // ternary
  if (ts.isConditionalExpression(node)) {
    const a = resolveNodeValue(node.whenTrue, checker, paramMap, seen);
    const b = resolveNodeValue(node.whenFalse, checker, paramMap, seen);
    return {
      values: [...new Set([...a.values, ...b.values])],
      dynamic: true,
    };
  }

  // object (event/name priority)
  if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p)) {
        const key = p.name.getText();
        if (key === "event" || key === "name") {
          return resolveNodeValue(p.initializer, checker, paramMap, seen);
        }
      }
    }
    const vals: string[] = [];
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const r = resolveNodeValue(p.initializer, checker, paramMap, seen);
      vals.push(...r.values);
    }
    return { values: [...new Set(vals)], dynamic: true };
  }

  // array
  if (ts.isArrayLiteralExpression(node)) {
    const vals: string[] = [];
    for (const el of node.elements) {
      const r = resolveNodeValue(el, checker, paramMap, seen);
      vals.push(...r.values);
    }
    return { values: [...new Set(vals)], dynamic: true };
  }

  // concat
  if (ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolveNodeValue(node.left, checker, paramMap, seen);
    const r = resolveNodeValue(node.right, checker, paramMap, seen);
    return {
      values: l.values.flatMap(a =>
        r.values.length ? r.values.map(b => a + b) : [a + "*"]
      ),
      dynamic: true,
    };
  }

  // identifier (const / enum)
  if (ts.isIdentifier(node)) {
    let s = checker.getSymbolAtLocation(node);
    if (!s) return { values: [], dynamic: true };

    s = resolveExportedSymbol(s, checker) ?? s;

    for (const d of s.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(d) && d.initializer) {
        return resolveNodeValue(d.initializer, checker, paramMap, seen);
      }
      if (ts.isEnumMember(d) && d.initializer && ts.isStringLiteral(d.initializer)) {
        return { values: [d.initializer.text], dynamic: false };
      }
    }
    return { values: [], dynamic: true };
  }

  // PROPERTY ACCESS (OBJECT + ENUM)
  if (ts.isPropertyAccessExpression(node)) {
    const obj = node.expression;
    const prop = node.name.text;

    // object literal lookup
    if (ts.isIdentifier(obj)) {
      const sym = checker.getSymbolAtLocation(obj);
      if (sym) {
        const s = resolveExportedSymbol(sym, checker) ?? sym;
        for (const d of s.getDeclarations() ?? []) {
          if (
            ts.isVariableDeclaration(d) &&
            d.initializer &&
            ts.isObjectLiteralExpression(d.initializer)
          ) {
            for (const p of d.initializer.properties) {
              if (
                ts.isPropertyAssignment(p) &&
                p.name.getText() === prop
              ) {
                return resolveNodeValue(p.initializer, checker, paramMap, seen);
              }
            }
          }
        }
      }
    }

    // enum fallback
    const sym = checker.getSymbolAtLocation(node);
    if (sym) {
      let s = resolveExportedSymbol(sym, checker) ?? sym;
      if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
      for (const d of s.getDeclarations() ?? []) {
        if (ts.isEnumMember(d) && d.initializer && ts.isStringLiteral(d.initializer)) {
          return { values: [d.initializer.text], dynamic: false };
        }
      }
    }

    return { values: [], dynamic: true };
  }

  // CALL (unwrap + dive into wrapper body)
  if (ts.isCallExpression(node)) {
    const vals: string[] = [];

    // args
    for (const a of node.arguments) {
      const r = resolveNodeValue(a, checker, paramMap, seen);
      vals.push(...r.values);
    }

    // dive into called function (wrapper support)
    const fn = resolveFunctionFromCall(node.expression, checker);
    if (fn?.body) {
      const r = resolveNodeValue(fn.body, checker, paramMap, seen);
      vals.push(...r.values);
    }

    return { values: [...new Set(vals)], dynamic: true };
  }

  return { values: [], dynamic: true };
}
