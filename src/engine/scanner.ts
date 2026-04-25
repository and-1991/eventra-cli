import ts from "typescript";
import { resolveNodeValue } from "./resolver";
import { resolveFunctionFromCall } from "./callResolver";

export function scanSource(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  visited = new Set<string>()
) {
  const events = new Set<string>();

  if (visited.has(source.fileName)) return events;
  visited.add(source.fileName);

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = getCallName(node.expression);

      if (/(track|event|capture|send)/i.test(name)) {
        let target = node.arguments[0];

        const fn = resolveFunctionFromCall(node.expression, checker);

        // 🔥 cross-file
        if (fn) {
          const sf = fn.getSourceFile();

          if (!visited.has(sf.fileName)) {
            scanSource(sf, checker, visited).forEach(e => events.add(e));
          }
        }

        if (target) {
          const res = resolveNodeValue(target, checker);

          res?.values.forEach(v => {
            if (v && v.length > 1 && !v.includes(" ")) {
              events.add(v);
            }
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);

  return events;
}

function getCallName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;

  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }

  return "";
}
