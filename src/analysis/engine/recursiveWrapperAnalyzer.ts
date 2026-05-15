import ts from "typescript";

import { EventraConfig, ScanResult } from "../../types";
import { WrapperRegistry } from "../symbols/wrapperRegistry";
import { EvaluationCache } from "../cache/evaluationCache";
import { ResolvedCallCache } from "../cache/resolvedCallCache";
import { ReturnPropagationCache } from "../cache/returnPropagationCache";
import { ResolvedExportCache } from "../cache/resolvedExportCache";
import { analyzeWrapperPropagation } from "../scanner/analyzer/propagationAnalyzer";
import { WrapperSemanticInfo, TrackSink } from "../shared/propagation";
import { extractEvents } from "../extractor/extractor";

export async function analyzeFileRecursive(sourceFile: ts.SourceFile, config: EventraConfig, wrapperRegistry: WrapperRegistry, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache, returnPropagationCache: ReturnPropagationCache, resolvedExportCache: ResolvedExportCache): Promise<ScanResult> {
  const checker = wrapperRegistry["checker"];
  const sinks: TrackSink[] = [];
  const wrappers: WrapperSemanticInfo[] = [];
  const trackCalls: {
    node: ts.CallExpression;
    sourceFile: ts.SourceFile;
    trackedArguments: ts.Expression[];
  }[] = [];

  // Support empty functionWrappers
  const wrapperNames = new Set(config.functionWrappers?.map(w => w.name) ?? []);

  function visit(node: ts.Node, parentFunction?: ts.FunctionLikeDeclaration) {
    // Detect calls to configured wrapper functions
    if (ts.isCallExpression(node)) {
      const callName = getCallName(node.expression);
      if (wrapperNames.has(callName)) {
        // Track this wrapper call
        sinks.push({ call: node, trackedArguments: [{ index: 0, propertyPath: [] }] });
        trackCalls.push({
          node,
          sourceFile,
          trackedArguments: node.arguments.filter(ts.isExpression)
        });
      }
    }

    // Detect and analyze function declarations / expressions / methods
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const localSinks = sinks.filter(s => isNodeInside(s.call, node));
      const wrapper = analyzeWrapperPropagation(node, checker, localSinks);
      if (wrapper) {
        wrappers.push(wrapper);
        wrapperRegistry.set(wrapper);
      }

      // Recurse into function body
      if (node.body) {
        ts.forEachChild(node.body, child => visit(child, node));
      }
      return;
    }

    // Recurse into child nodes
    ts.forEachChild(node, child => visit(child, parentFunction));
  }

  visit(sourceFile);

  // Extract events from tracked calls and wrapper metadata
  return extractEvents(
    {
      fileName: sourceFile.fileName,
      sourceFile,
      sinks,
      trackCalls,
      wrappers,
    },
    checker,
    config,
    evaluationCache,
    resolvedExportCache,
    resolvedCallCache,
    returnPropagationCache,
    wrapperRegistry
  );
}

function isNodeInside(child: ts.Node, fn: ts.FunctionLikeDeclaration): boolean {
  let current: ts.Node | undefined = child;
  while (current) {
    if (current === fn) return true;
    current = current.parent;
  }
  return false;
}

function getCallName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) return expr.name.text;
  return "";
}
