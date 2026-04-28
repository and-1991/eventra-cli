import ts from "typescript";
import { resolveNodeValue } from "./resolver";
import { resolveFunctionFromCall } from "./callResolver";
import { findTrackParamIndex } from "./functionAnalyzer";

function getCallName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;

  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }

  return "";
}

function pickBestArg(
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
  paramMap: Map<string, ts.Expression>
) {
  let best: { score: number; node: ts.Expression } | null = null;

  for (const arg of args) {
    const res = resolveNodeValue(arg, checker, paramMap);

    if (!res?.values?.length) continue;

    let score = 0;

    if (!res.dynamic) score += 3;
    if (res.values.every(v => v.length < 50)) score += 2;
    if (res.values.some(v => v.includes("*"))) score -= 2;

    if (!best || score > best.score) {
      best = { score, node: arg };
    }
  }

  return best?.node;
}

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

        const paramMap = new Map<string, ts.Expression>();

        if (fn && ts.isFunctionLike(fn)) {
          fn.parameters.forEach((param, index) => {
            const arg = node.arguments[index];
            if (!arg) return;

            if (ts.isIdentifier(param.name)) {
              paramMap.set(param.name.text, arg);
            }
          });
        }

        if (fn && ts.isFunctionLike(fn)) {
          const idx = findTrackParamIndex(fn);

          if (idx !== null) {
            const realArg = node.arguments[idx];

            if (realArg) {
              const res = resolveNodeValue(realArg, checker, paramMap);

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

              return;
            }
          }
        }

        // fallback (heuristic)
        const target = pickBestArg(node.arguments, checker, paramMap);

        if (target) {
          const res = resolveNodeValue(target, checker, paramMap);

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
