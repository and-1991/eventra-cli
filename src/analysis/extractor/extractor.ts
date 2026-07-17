import ts from "typescript";

import {EventraConfig, ScanResult} from "../../types";
import {FileSemanticIndex} from "../shared/types";
import {resolveNodeValue} from "../resolver/resolver";
import {createEvaluationContext} from "../shared/evaluationContext";
import {EvaluationCache} from "../cache/evaluationCache";
import {ResolvedExportCache} from "../cache/resolvedExportCache";
import {ResolvedCallCache} from "../cache/resolvedCallCache";
import {ReturnPropagationCache} from "../cache/returnPropagationCache";
import {WrapperRegistry} from "../symbols/wrapperRegistry";
import {extractPropagationEvents} from "./propagationExtractor";
import {normalizeEventName} from "../shared/eventValidation";
import {DynamicOccurrence, recordDynamicOccurrence} from "../shared/dynamicOccurrence";

export function extractEvents(index: FileSemanticIndex, checker: ts.TypeChecker, _config: EventraConfig, evaluationCache: EvaluationCache, exportCache: ResolvedExportCache, resolvedCallCache: ResolvedCallCache, returnPropagationCache: ReturnPropagationCache, wrapperRegistry: WrapperRegistry): ScanResult {
  const events = new Set<string>();
  const dynamicOccurrences: DynamicOccurrence[] = [];
  // direct track sinks
  for (const call of index.trackCalls) {
    for (const argument of call.trackedArguments) {
      const resolved = resolveNodeValue(argument, checker, createEvaluationContext(), new Set(), evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      for (const value of resolved.values) {
        const normalized = normalizeEventName(value);
        if (normalized) {
          events.add(normalized);
        }
      }
      if (resolved.dynamic) {
        recordDynamicOccurrence(call.node, resolved.values, dynamicOccurrences);
      }
    }
  }
  const propagationVisited = new Set<ts.Signature>();

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      extractPropagationEvents(node, checker, wrapperRegistry, resolvedCallCache, returnPropagationCache, evaluationCache, exportCache, events, propagationVisited, dynamicOccurrences);
    }
    ts.forEachChild(node, visit);
  }

  visit(index.sourceFile);

  return {
    events,
    detectedFunctionWrappers: new Set(index.wrappers.map(wrapper => wrapper.symbol.getName())),
    dynamicOccurrences,
  };
}
