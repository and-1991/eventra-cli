import ts from "typescript";
import { resolveNodeValue } from "./resolver";
import { resolveFunctionFromCall } from "./callResolver";
import { resolveExportedSymbol } from "./exportResolver";
import { findTrackParamIndex } from "./functionAnalyzer";
import { EventraConfig } from "../types";
import { isExternalFile } from "./boundary";
import { isTrackingCall } from "./trackingDetector";

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

function resolveFunctionDeep(
  expr: ts.Expression,
  checker: ts.TypeChecker
): ts.FunctionLikeDeclaration | null {
  let fn = resolveFunctionFromCall(expr, checker);
  if (fn) return fn;

  let symbol = checker.getSymbolAtLocation(expr);

  if (!symbol) return null;

  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }

  const resolvedSymbol =
    resolveExportedSymbol(symbol, checker) ?? symbol;

  for (const decl of resolvedSymbol.getDeclarations() ?? []) {
    if (ts.isFunctionDeclaration(decl)) {
      return decl;
    }

    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) ||
        ts.isFunctionExpression(decl.initializer))
    ) {
      return decl.initializer;
    }
  }

  return null;
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
  depth = 0,
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
    // CALL EXPRESSIONS
    if (ts.isCallExpression(node)) {
      const name = getCallName(node.expression);

      const isKnownWrapper = config.functionWrappers.some(
        w => w.name === name
      );

      const isTrackingByType = isTrackingCall(node, checker);

      const resolvedFn = resolveFunctionDeep(
        node.expression,
        checker
      );

      const isAutoWrapper =
        resolvedFn && findTrackParamIndex(resolvedFn) !== null;

      let isTracking =
        isKnownWrapper ||
        isTrackingByType ||
        name.startsWith("$") ||
        (isAutoWrapper &&
          resolvedFn &&
          resolvedFn.getSourceFile &&
          !isExternalFile(resolvedFn.getSourceFile().fileName));

      if (!isTracking) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "track"
        ) {
          isTracking = true;
        } else if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "track"
        ) {
          isTracking = true;
        }
      }

      if (!isTracking) {
        ts.forEachChild(node, visit);
        return;
      }

      // DETECT WRAPPER
      if (
        !isKnownWrapper &&
        isAutoWrapper &&
        !isTrackingByType &&
        !name.startsWith("track")
      ) {
        detectedFunctionWrappers.add(name);
      }

      // PARAM MAP
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

      // STRICT EVENT RESOLVE
      if (resolvedFn) {
        const idx = findTrackParamIndex(resolvedFn);

        if (idx !== null && node.arguments[idx]) {
          const res = resolveNodeValue(
            node.arguments[idx],
            checker,
            paramMap
          );

          res.values.forEach(v => {
            if (isValidEvent(v)) events.add(v);
          });
        }
      }

      // CROSS-FILE
      if (resolvedFn) {
        const sf = resolvedFn.getSourceFile?.();

        if (sf && !visited.has(sf.fileName)) {
          const res = scanSource(
            sf,
            checker,
            config,
            visited,
            depth + 1,
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
