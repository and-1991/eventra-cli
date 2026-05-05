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

function getJsxAttrName(name: ts.JsxAttributeName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return name.name.text;
  return null;
}

// unwrap
function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
    ) {
    expr = expr.expression;
  }
  return expr;
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

function isPropUsedInTracking(
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  prop: string
) {
  let found = false;

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      if (!isTrackingCall(node, checker)) {
        ts.forEachChild(node, visit);
        return;
      }

      for (const arg of node.arguments) {
        const a = unwrap(arg as ts.Expression);

        if (
          (ts.isIdentifier(a) && a.text === prop) ||
          (ts.isPropertyAccessExpression(a) &&
            a.name.text === prop)
        ) {
          found = true;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  if (fn.body) {
    visit(fn.body);
  }

  return found;
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

      let resolvedFn = resolveFunctionFromCall(node.expression, checker);

      const isAutoWrapper =
        resolvedFn && findTrackParamIndex(resolvedFn) !== null;

      let isTracking =
        isKnownWrapper ||
        isTrackingByType ||
        isAutoWrapper ||
        name.startsWith("$");

      // fallback track(...)
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

      // DETECT WRAPPERS
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

      let handled = false;

      // MAIN RESOLVE
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

          handled = true;
        }
      }

      // fallback
      if (!handled) {
        for (const arg of node.arguments) {
          const res = resolveNodeValue(arg, checker, paramMap);

          res.values.forEach(v => {
            if (isValidEvent(v)) events.add(v);
          });
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
            depth + 1,
            paramMap
          );

          res.events.forEach(e => events.add(e));
        }
      }
    }

    // JSX
    if (
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxOpeningElement(node)
    ) {
      const tagNode =
        ts.isPropertyAccessExpression(node.tagName)
          ? node.tagName.name
          : node.tagName;

      let symbol = checker.getSymbolAtLocation(tagNode);

      if (symbol) {
        symbol = resolveExportedSymbol(symbol, checker) ?? symbol;
      }

      if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
        symbol = checker.getAliasedSymbol(symbol);
      }

      if (!symbol) {
        ts.forEachChild(node, visit);
        return;
      }

      const tagName =
        ts.isPropertyAccessExpression(node.tagName)
          ? node.tagName.name.getText()
          : node.tagName.getText();

      for (const decl of symbol.getDeclarations() ?? []) {
        let fn: ts.FunctionLikeDeclaration | null = null;

        if (ts.isFunctionDeclaration(decl)) fn = decl;

        if (ts.isVariableDeclaration(decl) && decl.initializer) {
          const init = decl.initializer;

          if (
            ts.isArrowFunction(init) ||
            ts.isFunctionExpression(init)
          ) {
            fn = init;
          }
        }

        if (!fn) continue;

        const param = fn.parameters[0];
        if (!param || !ts.isObjectBindingPattern(param.name)) continue;

        for (const el of param.name.elements) {
          const prop = el.name.getText();

          const isEvent =
            isPropUsedInTracking(fn, checker, prop) ||
            config.wrappers.some(
              w => w.name === tagName && w.prop === prop
            );

          if (!isEvent) continue;

          const attr = node.attributes.properties.find(p => {
            if (!ts.isJsxAttribute(p)) return false;
            return getJsxAttrName(p.name) === prop;
          }) as ts.JsxAttribute | undefined;

          if (!attr || !attr.initializer) continue;

          const expr = ts.isJsxExpression(attr.initializer)
            ? attr.initializer.expression
            : attr.initializer;

          if (!expr) continue;

          const paramMap = new Map<string, ts.Expression>();
          paramMap.set(prop, expr);

          const res = scanSource(
            fn.getSourceFile(),
            checker,
            config,
            visited,
            depth + 1,
            paramMap
          );

          res.events.forEach(e => events.add(e));

          detectedComponentWrappers.set(tagName, prop);
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
