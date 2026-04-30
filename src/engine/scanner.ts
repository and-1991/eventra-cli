import ts from "typescript";
import { resolveNodeValue } from "./resolver";
import { resolveFunctionFromCall } from "./callResolver";
import { resolveExportedSymbol } from "./exportResolver";
import { findTrackParamIndex } from "./functionAnalyzer";
import { EventraConfig } from "../types";
import { isExternalFile } from "./boundary";

const TRACKING_NAMES = new Set(["track", "event", "capture", "send"]);

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
  prop: string
) {
  let found = false;

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = getCallName(node.expression);

      if (!TRACKING_NAMES.has(name)) return;

      for (const arg of node.arguments) {
        if (
          (ts.isIdentifier(arg) && arg.text === prop) ||
          (ts.isPropertyAccessExpression(arg) &&
            arg.name.text === prop)
        ) {
          found = true;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(fn);
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

  if (depth > 5 || visited.has(source.fileName)) {
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

      const fn = resolveFunctionFromCall(node.expression, checker);

      const isAutoWrapper =
        fn && findTrackParamIndex(fn) !== null;

      const isTracking =
        isKnownWrapper ||
        TRACKING_NAMES.has(name) ||
        (isAutoWrapper &&
          fn &&
          !isExternalFile(fn.getSourceFile().fileName));

      if (!isTracking) return;

      if (!isKnownWrapper && isAutoWrapper && !TRACKING_NAMES.has(name)) {
        detectedFunctionWrappers.add(name);
      }

      // paramMap
      const paramMap = new Map(inheritedParamMap ?? []);

      if (fn && ts.isFunctionLike(fn)) {
        fn.parameters.forEach((param, i) => {
          const arg = node.arguments[i];
          if (!arg) return;

          if (ts.isIdentifier(param.name)) {
            paramMap.set(param.name.text, arg);
          }
        });
      }

      let handled = false;

      if (fn) {
        const idx = findTrackParamIndex(fn);

        if (idx !== null && node.arguments[idx]) {
          const res = resolveNodeValue(
            node.arguments[idx],
            checker,
            paramMap
          );

          res?.values.forEach(v => {
            if (isValidEvent(v)) events.add(v);
          });

          handled = true;
        }
      }

      // fallback
      if (!handled) {
        for (const arg of node.arguments) {
          const res = resolveNodeValue(arg, checker, paramMap);

          res?.values.forEach(v => {
            if (isValidEvent(v)) events.add(v);
          });
        }
      }

      // cross-file WITH paramMap
      if (fn) {
        const sf = fn.getSourceFile();

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

    // JSX COMPONENTS
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

      if (!symbol) return;

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
            isPropUsedInTracking(fn, prop) ||
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
