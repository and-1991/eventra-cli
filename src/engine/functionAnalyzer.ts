import ts from "typescript";

export function findTrackParamIndex(
  fn: ts.FunctionLikeDeclaration
): number | null {
  const paramIndex = new Map<string, number>();

  fn.parameters.forEach((p, i) => {
    if (ts.isIdentifier(p.name)) {
      paramIndex.set(p.name.text, i);
    }
  });

  let result: number | null = null;

  function check(arg: ts.Expression): boolean {
    // identifier
    if (ts.isIdentifier(arg)) {
      const idx = paramIndex.get(arg.text);
      if (idx !== undefined) {
        result = idx;
        return true;
      }
    }

    // template
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
    }

    // object { event: name }
    if (ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;

        const key = prop.name.getText();

        if (["event", "name", "type"].includes(key)) {
          return check(prop.initializer);
        }
      }
    }

    return false;
  }

  function visit(node: ts.Node) {
    if (result !== null) return;

    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      const isTrack =
        (ts.isIdentifier(expr) && expr.text === "track") ||
        (ts.isPropertyAccessExpression(expr) &&
          expr.name.text === "track");

      if (!isTrack) return;

      for (const arg of node.arguments) {
        if (check(arg)) return;
      }
    }

    ts.forEachChild(node, visit);
  }

  if (fn.body) {
    visit(fn.body);
  }

  return result;
}
