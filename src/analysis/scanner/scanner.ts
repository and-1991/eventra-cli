import ts from "typescript";

import {FileSemanticIndex, TrackCall} from "../shared/types";
import {TrackSink, WrapperSemanticInfo} from "../shared/propagation";
import {detectTrackSink} from "./sinkDetector";
import {analyzeWrapperPropagation} from "./analyzer/propagationAnalyzer";
import {WrapperRegistry} from "../symbols/wrapperRegistry";

export function scanSource(source: ts.SourceFile, checker: ts.TypeChecker, wrapperRegistry: WrapperRegistry,): FileSemanticIndex {
  const sinks: TrackSink[] = [];
  const wrappers: WrapperSemanticInfo[] = [];
  const trackCalls: TrackCall[] = [];
  const functions: ts.FunctionLikeDeclaration[] = [];

  function visit(node: ts.Node): void {
    // imports/exports are irrelevant
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return;
    }
    // function collection
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      functions.push(node);
    }
    // sink detection
    if (ts.isCallExpression(node)) {
      const sink = detectTrackSink(node);
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
            if (tracked.propertyPath.length > 0 && ts.isObjectLiteralExpression(argument)) {
              const property = argument.properties.find(prop => {
                  return (
                    ts.isPropertyAssignment(prop) && prop.name.getText() === tracked.propertyPath[0]
                  );
                },
              );
              if (property && ts.isPropertyAssignment(property)) {
                return property.initializer;
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
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);

  // semantic wrapper analysis
  for (const fn of functions) {
    if (!fn.body) {
      continue;
    }
    const localSinks = sinks.filter(sink => {
        let current: ts.Node | undefined = sink.call;
        while (current) {
          if (current === fn) {
            return true;
          }
          current = current.parent;
        }
        return false;
      },
    );
    const wrapper = analyzeWrapperPropagation(fn, checker, localSinks);
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
  };
}
