import ts from "typescript";

export function findTrackParamIndex(
  fn: ts.FunctionLikeDeclaration
): number | null {
  const paramIndex = new Map<string, number>();

  fn.parameters.forEach((p, i) => {
    if (ts.isIdentifier(p.name)) {
      paramIndex.set(p.name.text, i);

      // default param: (name = "x")
      if (p.initializer && ts.isStringLiteral(p.initializer)) {
        if (i === 0) return 0;
      }
    }
  });

  let result: number | null = null;

  function unwrap(node: ts.Expression): ts.Expression {
    // as / parentheses
    while (
      ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node)
      ) {
      node = node.expression;
    }
    return node;
  }

  function checkArg(arg: ts.Expression) {
    arg = unwrap(arg);

    // identifier → param
    if (ts.isIdentifier(arg)) {
      const idx = paramIndex.get(arg.text);
      if (idx !== undefined) {
        result = idx;
        return true;
      }
    }

    // string literal
    if (ts.isStringLiteral(arg)) {
      result = 0;
      return true;
    }

    // template `${name}`
    if (ts.isTemplateExpression(arg)) {
      for (const span of arg.templateSpans) {
        if (ts.isIdentifier(span.expression)) {
          const idx = paramIndex.get(span.expression.text);
          if (idx !== undefined) {
            result = idx;
            return true;
          }
        }
      }
      result = 0;
      return true;
    }

    // object { event: name }
    if (ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;

        const name = prop.name.getText();

        if (["event", "name", "type"].includes(name)) {
          return checkArg(prop.initializer);
        }
      }
    }

    // call: String(name)
    if (ts.isCallExpression(arg)) {
      for (const inner of arg.arguments) {
        if (checkArg(inner)) return true;
      }
    }

    return false;
  }

  function visit(node: ts.Node) {
    if (result !== null) return;

    if (ts.isCallExpression(node)) {
      let isTrackCall = false;

      if (ts.isPropertyAccessExpression(node.expression)) {
        if (node.expression.name.text === "track") {
          isTrackCall = true;
        }
      }

      if (ts.isIdentifier(node.expression)) {
        if (node.expression.text === "track") {
          isTrackCall = true;
        }
      }

      if (isTrackCall) {
        for (const arg of node.arguments) {
          if (checkArg(arg)) return;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  if (fn.body) {
    visit(fn.body);
  }

  return result;
}
