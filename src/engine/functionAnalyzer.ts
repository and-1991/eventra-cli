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

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      let isTrackCall = false;

      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;

        if (method === "track") {
          isTrackCall = true;
        }
      }

      // fallback
      if (ts.isIdentifier(node.expression)) {
        if (node.expression.text === "track") {
          isTrackCall = true;
        }
      }

      if (isTrackCall) {
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg)) {
            const idx = paramIndex.get(arg.text);
            if (idx !== undefined) {
              result = idx;
              return;
            }
          }

          if (ts.isStringLiteral(arg)) {
            result = 0;
            return;
          }
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
