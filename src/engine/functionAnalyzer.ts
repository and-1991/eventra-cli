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
      const name = getCallName(node.expression);

      if (/(track|event|capture|send)/i.test(name)) {
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg)) {
            const idx = paramIndex.get(arg.text);
            if (idx !== undefined) {
              result = idx;
              return;
            }
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

function getCallName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;

  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }

  return "";
}
