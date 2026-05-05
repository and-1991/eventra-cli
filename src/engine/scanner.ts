import ts from "typescript";
import { resolveNodeValue } from "./resolver";
import { resolveFunctionFromCall } from "./callResolver";
import { resolveExportedSymbol } from "./exportResolver";
import { EventraConfig, ScanResult } from "../types";

// HELPERS
function isValidEvent(v: string) {
  return (
    v &&
    v.length > 1 &&
    v.length < 120 &&
    !v.includes(" ") &&
    /^[a-zA-Z0-9._:-]+$/.test(v)
  );
}

function getCallName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return "";
}

function getJsxTagName(tag: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
  return tag.getText();
}

function getJsxAttrName(name: ts.JsxAttributeName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return name.name.text;
  return "";
}

// MAIN
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

  if (visited.has(source.fileName)) {
    return { events, detectedFunctionWrappers, detectedComponentWrappers };
  }

  visited.add(source.fileName);

  // TRACK DETECTION
  function isTrackCall(expr: ts.Expression) {
    if (ts.isIdentifier(expr)) {
      return expr.text === "track";
    }

    if (ts.isPropertyAccessExpression(expr)) {
      return expr.name.text === "track";
    }

    return false;
  }

  function extractTrackCall(
    node: ts.CallExpression,
    paramMap: Map<string, ts.Expression>
  ) {
    if (!isTrackCall(node.expression)) return;

    const arg = node.arguments[0];
    if (!arg) return;

    const res = resolveNodeValue(arg, checker, paramMap);

    for (const v of res.values) {
      if (isValidEvent(v)) {
        events.add(v);
      }
    }
  }

  // WRAPPER DETECTION
  function isWrapperFunction(fn: ts.FunctionLikeDeclaration) {
    let found = false;

    function walk(n: ts.Node) {
      if (found) return;

      if (ts.isCallExpression(n) && isTrackCall(n.expression)) {
        found = true;
        return;
      }

      ts.forEachChild(n, walk);
    }

    if (fn.body) walk(fn.body);
    return found;
  }

  // COMPONENT WRAPPER
  function detectComponentWrapper(tag: ts.JsxTagNameExpression): string | null {
    const tagName = getJsxTagName(tag);

    if (wrapperCache.has(tagName)) {
      return wrapperCache.get(tagName)!;
    }

    let symbol = checker.getSymbolAtLocation(tag);

    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    if (!symbol) {
      wrapperCache.set(tagName, null);
      return null;
    }

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

      if (!fn || !fn.body) continue;

      let prop: string | null = null;

      function walk(n: ts.Node) {
        if (prop) return;

        if (ts.isCallExpression(n) && isTrackCall(n.expression)) {
          const arg = n.arguments[0];

          if (ts.isPropertyAccessExpression(arg)) {
            prop = arg.name.text;
            return;
          }
        }

        ts.forEachChild(n, walk);
      }

      walk(fn.body);

      wrapperCache.set(tagName, prop);

      if (prop) {
        detectedComponentWrappers.set(tagName, prop);
        return prop;
      }
    }

    wrapperCache.set(tagName, null);
    return null;
  }

  // VISITOR
  function visit(node: ts.Node) {
    // JSX
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tagName = getJsxTagName(node.tagName);

      if (tagName[0] === tagName[0].toLowerCase()) {
        ts.forEachChild(node, visit);
        return;
      }

      let wrapper = config.wrappers.find(w => w.name === tagName);

      if (!wrapper) {
        const prop = detectComponentWrapper(node.tagName);
        if (prop) wrapper = { name: tagName, prop };
      }

      if (wrapper) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;

          const name = getJsxAttrName(attr.name);
          if (name !== wrapper.prop) continue;

          if (!attr.initializer) continue;

          if (ts.isStringLiteral(attr.initializer)) {
            if (isValidEvent(attr.initializer.text)) {
              events.add(attr.initializer.text);
            }
          }

          if (ts.isJsxExpression(attr.initializer)) {
            const expr = attr.initializer.expression;
            if (!expr) continue;

            const res = resolveNodeValue(expr, checker);
            res.values.forEach(v => {
              if (isValidEvent(v)) events.add(v);
            });
          }
        }
      }

      ts.forEachChild(node, visit);
      return;
    }

    // CALL
    if (ts.isCallExpression(node)) {
      const resolvedFn = resolveFunctionFromCall(node.expression, checker);

      const paramMap = new Map(inheritedParamMap ?? []);

      if (resolvedFn) {
        resolvedFn.parameters.forEach((p, i) => {
          const arg = node.arguments[i];
          if (!arg) return;

          if (ts.isIdentifier(p.name)) {
            paramMap.set(p.name.text, arg);
          }
        });
      }

      extractTrackCall(node, paramMap);

      if (resolvedFn && isWrapperFunction(resolvedFn)) {
        const name = getCallName(node.expression);

        if (name && name !== "track") {
          detectedFunctionWrappers.add(name);
        }

        if (resolvedFn.body) {
          visit(resolvedFn.body);
        }
      }

      if (resolvedFn && resolvedFn.body) {
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

      node.arguments.forEach(visit);
      visit(node.expression);

      return;
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
