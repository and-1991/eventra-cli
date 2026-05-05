import ts from "typescript";
import { resolveNodeValue } from "./resolver";
import { resolveFunctionFromCall } from "./callResolver";
import { findTrackParamIndex } from "./functionAnalyzer";
import { resolveExportedSymbol } from "./exportResolver";
import { EventraConfig, ScanResult } from "../types";
import { isExternalFile } from "./boundary";

// UTILS
function getJsxAttrName(name: ts.JsxAttributeName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return name.name.text;
  return "";
}

function getJsxTagName(tag: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tag)) return tag.text;

  if (ts.isPropertyAccessExpression(tag)) {
    return tag.name.text;
  }

  return "";
}

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

// COMPONENT ANALYSIS
function getComponentPropsMap(
  fn: ts.FunctionLikeDeclaration
): Map<string, string> {
  const map = new Map<string, string>();
  const firstParam = fn.parameters[0];
  if (!firstParam) return map;

  // ({ event }) => ...
  if (ts.isObjectBindingPattern(firstParam.name)) {
    for (const el of firstParam.name.elements) {
      if (!ts.isBindingElement(el)) continue;

      const propName =
        el.propertyName?.getText() || el.name.getText();

      map.set(el.name.getText(), propName);
    }
  }

  // (props) => props.event
  if (ts.isIdentifier(firstParam.name)) {
    map.set(firstParam.name.text, "*");
  }

  return map;
}

function findTrackedPropName(
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker
): string | null {
  const propMap = getComponentPropsMap(fn);
  let result: string | null = null;

  function resolveIdentifierToProp(
    node: ts.Identifier
  ): string | null {
    const mapped = propMap.get(node.text);
    if (mapped && mapped !== "*") return mapped;

    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return null;

    for (const decl of symbol.getDeclarations() ?? []) {
      // const e = props.event
      if (
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        ts.isPropertyAccessExpression(decl.initializer)
      ) {
        return decl.initializer.name.text;
      }

      // const e = event
      if (
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        ts.isIdentifier(decl.initializer)
      ) {
        const inner = propMap.get(decl.initializer.text);
        if (inner) return inner;
      }
    }

    return null;
  }

  function visit(node: ts.Node) {
    if (result) return;

    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      const isTrack =
        (ts.isIdentifier(expr) && expr.text === "track") ||
        (ts.isPropertyAccessExpression(expr) &&
          expr.name.text === "track");

      if (!isTrack) {
        ts.forEachChild(node, visit);
        return;
      }

      for (const arg of node.arguments) {
        // track(event)
        if (ts.isIdentifier(arg)) {
          const prop = resolveIdentifierToProp(arg);
          if (prop) {
            result = prop;
            return;
          }
        }

        // track(props.a.b.event)
        if (ts.isPropertyAccessExpression(arg)) {
          let current = arg;

          while (ts.isPropertyAccessExpression(current)) {
            result = current.name.text;
            return;
          }
        }

        // track(fn())
        if (ts.isCallExpression(arg)) {
          const inner = resolveFunctionFromCall(
            arg.expression,
            checker
          );

          if (inner?.body) {
            visit(inner.body);
            if (result) return;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  if (fn.body) visit(fn.body);

  return result;
}

// MAIN SCANNER
export function scanSource(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  config: EventraConfig,
  visited = new Set<string>(),
  inheritedParamMap?: Map<string, ts.Expression>,
  wrapperCache = new Map<string, string | null>()
): ScanResult {
  const events = new Set<string>();
  const detectedFunctionWrappers = new Set<string>();
  const detectedComponentWrappers = new Map<string, string>();

  if (visited.has(source.fileName) || visited.size > 200) {
    return { events, detectedFunctionWrappers, detectedComponentWrappers };
  }

  visited.add(source.fileName);

  function visit(node: ts.Node) {
    // JSX WRAPPERS
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tagName = getJsxTagName(node.tagName);

      // skip html
      if (tagName[0] === tagName[0].toLowerCase()) {
        ts.forEachChild(node, visit);
        return;
      }

      let wrapper = config.wrappers.find(w => w.name === tagName);

      // AUTO DETECT
      if (!wrapper) {
        if (wrapperCache.has(tagName)) {
          const cached = wrapperCache.get(tagName);
          if (cached) wrapper = { name: tagName, prop: cached };
        } else {
          let symbol = checker.getSymbolAtLocation(node.tagName);

          if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
            symbol = checker.getAliasedSymbol(symbol);
          }

          if (symbol) {
            symbol = resolveExportedSymbol(symbol, checker) ?? symbol;

            for (const decl of symbol.getDeclarations() ?? []) {
              let fn: ts.FunctionLikeDeclaration | null = null;

              if (ts.isFunctionDeclaration(decl)) fn = decl;

              if (
                ts.isVariableDeclaration(decl) &&
                decl.initializer &&
                (ts.isArrowFunction(decl.initializer) ||
                  ts.isFunctionExpression(decl.initializer))
              ) {
                fn = decl.initializer;
              }

              if (!fn) continue;

              const prop = findTrackedPropName(fn, checker);
              wrapperCache.set(tagName, prop ?? null);

              if (prop) {
                wrapper = { name: tagName, prop };
                detectedComponentWrappers.set(tagName, prop);
                break;
              }
            }
          }
        }
      }

      if (wrapper) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;

          const name = getJsxAttrName(attr.name);
          if (name !== wrapper.prop) continue;

          if (!attr.initializer) continue;

          if (ts.isStringLiteral(attr.initializer)) {
            const v = attr.initializer.text;
            if (isValidEvent(v)) events.add(v);
          }

          if (ts.isJsxExpression(attr.initializer)) {
            const expr = attr.initializer.expression;
            if (!expr) continue;

            const res = resolveNodeValue(expr, checker, inheritedParamMap);

            res.values.forEach(v => {
              if (isValidEvent(v)) events.add(v);
            });
          }
        }
      }

      ts.forEachChild(node, visit);
      return;
    }

    // FUNCTION CALLS
    if (ts.isCallExpression(node)) {
      let trackParamIndex: number | null = null;
      let isTracking = false;

      const callName = getCallName(node.expression);

      // direct .track()
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "track"
      ) {
        isTracking = true;
        trackParamIndex = 0;
      }

      // config wrapper
      const manualWrapper = config.functionWrappers.find(
        w => w.name === callName
      );

      if (manualWrapper) {
        isTracking = true;
        trackParamIndex = 0;
      }

      // resolve function → check body
      const resolvedFn = resolveFunctionFromCall(
        node.expression,
        checker
      );

      if (resolvedFn) {
        const idx = findTrackParamIndex(resolvedFn);

        if (idx !== null) {
          isTracking = true;
          trackParamIndex = idx;

          if (!manualWrapper && callName !== "track") {
            detectedFunctionWrappers.add(callName);
          }
        }
      }

      if (!isTracking) {
        ts.forEachChild(node, visit);
        return;
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

      if (trackParamIndex !== null && node.arguments[trackParamIndex]) {
        const res = resolveNodeValue(
          node.arguments[trackParamIndex],
          checker,
          paramMap
        );

        res.values.forEach(v => {
          if (isValidEvent(v)) events.add(v);
        });
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
            paramMap,
            wrapperCache
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
