import ts from "typescript";
import { resolveNodeValue } from "./resolver";
import { resolveFunctionFromCall } from "./callResolver";
import { findTrackParamIndex } from "./functionAnalyzer";
import { EventraConfig } from "../types";
import { isExternalFile } from "./boundary";

function getCallName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return "";
}

function isValidEvent(v: string) {
  return (
    v &&
    v.length > 1 &&
    v.length < 100 &&
    !v.includes(" ") &&
    /^[a-zA-Z0-9._:-]+$/.test(v)
  );
}

export type ScanResult = {
  events: Set<string>;
  detectedFunctionWrappers: Set<string>;
  detectedComponentWrappers: Map<string, string>;
};

export function scanSource(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  config: EventraConfig,
  visited = new Set<string>(),
  inheritedParamMap?: Map<string, ts.Expression>
): ScanResult {
  const events = new Set<string>();
  const detectedFunctionWrappers = new Set<string>();
  const detectedComponentWrappers = new Map<string, string>();

  if (visited.size > 200 || visited.has(source.fileName)) {
    return { events, detectedFunctionWrappers, detectedComponentWrappers };
  }

  visited.add(source.fileName);

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = getCallName(node.expression);

      const isKnownWrapper = config.functionWrappers.some(
        w => w.name === name
      );

      const resolvedFn = resolveFunctionFromCall(node.expression, checker);

      const isAutoWrapper =
        !!resolvedFn && findTrackParamIndex(resolvedFn) !== null;

      const isTracking =
        name === "track" ||
        isKnownWrapper ||
        (isAutoWrapper &&
          resolvedFn &&
          !isExternalFile(resolvedFn.getSourceFile().fileName));

      if (!isTracking) {
        ts.forEachChild(node, visit);
        return;
      }

      // авто-детект wrapper
      if (!isKnownWrapper && isAutoWrapper && name !== "track") {
        detectedFunctionWrappers.add(name);
      }

      const paramMap = new Map(inheritedParamMap ?? []);

      if (resolvedFn && ts.isFunctionLike(resolvedFn)) {
        resolvedFn.parameters.forEach((param, i) => {
          const arg = node.arguments[i];
          if (!arg) return;

          if (ts.isIdentifier(param.name)) {
            paramMap.set(param.name.text, arg);
          }
        });
      }

      // ✅ ТОЛЬКО правильный аргумент
      if (resolvedFn) {
        const idx = findTrackParamIndex(resolvedFn);

        if (idx !== null && node.arguments[idx]) {
          const res = resolveNodeValue(
            node.arguments[idx],
            checker,
            paramMap
          );

          for (const v of res.values) {
            if (isValidEvent(v)) {
              events.add(v);
            }
          }
        }
      }

      // CROSS FILE
      if (resolvedFn) {
        const sf = resolvedFn.getSourceFile();

        if (!visited.has(sf.fileName)) {
          const res = scanSource(
            sf,
            checker,
            config,
            visited,
            paramMap
          );

          res.events.forEach(e => events.add(e));
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);

  return {
    events,
    detectedFunctionWrappers,
    detectedComponentWrappers,
  };
}
