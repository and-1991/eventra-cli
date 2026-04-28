import ts from "typescript";
import { resolveNodeValue } from "./resolver";
import { resolveFunctionFromCall } from "./callResolver";

export function scanSource(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  visited = new Set<string>(),
  depth = 0
): Set<string> {
  if (depth > 5) return new Set();
  const events = new Set<string>();

  if (visited.has(source.fileName)) return events;
  visited.add(source.fileName);

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = getCallName(node.expression);

      if (/(track|event|capture|send)/i.test(name)) {

        const fn = resolveFunctionFromCall(node.expression, checker);

        // param mapping
        let paramMap = new Map<string, ts.Expression>();

        if (fn && ts.isFunctionLike(fn)) {
          fn.parameters.forEach((param, index) => {
            const arg = node.arguments[index];
            if (!arg) return;

            if (ts.isIdentifier(param.name)) {
              paramMap.set(param.name.text, arg);
            }
          });
        }

        // cross-file traversal
        if (fn) {
          const sf = fn.getSourceFile();

          if (!visited.has(sf.fileName)) {
            scanSource(sf, checker, visited, depth + 1)
              .forEach(e => events.add(e));
          }
        }

        for (const arg of node.arguments) {
          const res = resolveNodeValue(arg, checker, paramMap);

          res?.values.forEach(v => {
            if (
              v &&
              v.length > 1 &&
              v.length < 100 &&
              !v.includes(" ") &&
              /^[a-zA-Z0-9._:-]+$/.test(v)
            ) {
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
