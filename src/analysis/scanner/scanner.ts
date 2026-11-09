import ts from "typescript";

import {unwrapExpression} from "../shared/utils";
import {FileSemanticIndex, TrackCall} from "../shared/types";
import {TrackSink, WrapperSemanticInfo} from "../shared/propagation";
import {detectTrackSink} from "./sinkDetector";
import {detectJsxEventAttribute} from "./jsxEventAttribute";
import {analyzeWrapperPropagation} from "./analyzer/propagationAnalyzer";
import {componentClassOfRender} from "../symbols/classComponent";
import {WrapperRegistry} from "../symbols/wrapperRegistry";
import type { PluginRegistry } from "../../plugin/registry";

export function scanSource(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  wrapperRegistry: WrapperRegistry,
  plugins: PluginRegistry,
): FileSemanticIndex {
  const sinks: TrackSink[] = [];
  const wrappers: WrapperSemanticInfo[] = [];
  const trackCalls: TrackCall[] = [];
  const functions: ts.FunctionLikeDeclaration[] = [];

  // Walked with an explicit stack: a long `"a" + "a" + ...` chain nests thousands of levels deep, and a
  // recursive walk overflowed the call stack and aborted the whole scan.
  function inspect(node: ts.Node): boolean {
    // imports/exports are irrelevant
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return false;
    }
    // function collection
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      functions.push(node);
    }
    // sink detection
    if (ts.isCallExpression(node)) {
      const sink = detectTrackSink(node, checker, plugins);
      if (sink) {
        sinks.push(sink);
        const trackedArguments = sink.trackedArguments.map(tracked => {
            const argument = node.arguments[tracked.index];
            if (!argument) {
              return undefined;
            }
            // track({
            //   event: name
            // })
            const argumentLiteral = unwrapExpression(argument);
            if (tracked.propertyPath.length > 0 && ts.isObjectLiteralExpression(argumentLiteral)) {
              const property = argumentLiteral.properties.find(prop => {
                  return (
                    (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
                    prop.name.getText() === tracked.propertyPath[0]
                  );
                },
              );
              if (property && ts.isPropertyAssignment(property)) {
                return property.initializer;
              }
              // track({ event })
              if (property && ts.isShorthandPropertyAssignment(property)) {
                return property.name;
              }
            }
            // track(name)
            return argument;
          },
        ).filter((value): value is ts.Expression => {
            return Boolean(value);
          },
        );
        trackCalls.push({
          node,
          sourceFile: source,
          trackedArguments,
          calleeText: node.expression.getText(source),
        });
      }
    }
    // JSX `event="..."`/`event={expr}` attribute detection (React/JSX files
    // only - a plain .ts/.js file never contains a JsxAttribute node).
    const jsxEventAttribute = detectJsxEventAttribute(node);
    if (jsxEventAttribute) {
      trackCalls.push(jsxEventAttribute);
    }
    return true;
  }

  const stack: ts.Node[] = [source];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!inspect(node)) continue;
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    // children are visited in source order, as the recursive walk did
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }

  // semantic wrapper analysis
  for (const fn of functions) {
    if (!fn.body) {
      continue;
    }
    // the render() of a class component reads the props in every method of the class, not only its own body
    const scope: ts.Node = componentClassOfRender(fn) ?? fn;
    const localSinks = sinks.filter(sink => {
        let current: ts.Node | undefined = sink.call;
        while (current) {
          if (current === scope) {
            return true;
          }
          current = current.parent;
        }
        return false;
      },
    );
    const wrapper =
      plugins.detectWrapper({ fn, checker, sinks: localSinks }) ??
      analyzeWrapperPropagation(fn, checker, localSinks);
    if (!wrapper) {
      continue;
    }
    wrappers.push(wrapper);
    wrapperRegistry.set(wrapper);
  }
  return {
    fileName: source.fileName,
    sourceFile: source,
    sinks,
    trackCalls,
    wrappers,
    functions,
  };
}
