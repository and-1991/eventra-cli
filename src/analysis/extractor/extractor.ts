// src/analysis/extractor/extractor.ts

import ts from "typescript";

import {
  EventraConfig,
  ScanResult,
} from "../../types";

import {
  FileSemanticIndex,
} from "../shared/types";

import {
  resolveNodeValue,
} from "../resolver/resolver";

import {
  createEvaluationContext,
} from "../shared/evaluationContext";

import {
  EvaluationCache,
} from "../cache/evaluationCache";

import {
  ResolvedExportCache,
} from "../cache/resolvedExportCache";

import {
  ResolvedCallCache,
} from "../cache/resolvedCallCache";

import {
  WrapperRegistry,
} from "../symbols/wrapperRegistry";

import {
  extractPropagationEvents,
} from "./propagationExtractor";

function isValidEvent(
  value: string,
): boolean {

  return (
    value.length > 0
    && value.length < 160
    && /^[a-zA-Z0-9:_./-]+$/.test(
      value,
    )
  );
}

export function extractEvents(
  index: FileSemanticIndex,

  checker: ts.TypeChecker,

  _config: EventraConfig,

  evaluationCache:
  EvaluationCache,

  exportCache:
  ResolvedExportCache,

  resolvedCallCache:
  ResolvedCallCache,

  wrapperRegistry:
  WrapperRegistry,
): ScanResult {

  const events =
    new Set<string>();

  //
  // direct track sinks
  //

  for (
    const call
    of index.trackCalls
    ) {

    for (
      const argument
      of call.trackedArguments
      ) {

      const resolved =
        resolveNodeValue(

          argument,

          checker,

          createEvaluationContext(),

          new Set(),

          evaluationCache,

          resolvedCallCache,

          exportCache,
        );

      for (
        const value
        of resolved.values
        ) {

        if (
          isValidEvent(
            value,
          )
        ) {

          events.add(
            value,
          );
        }
      }
    }
  }

  //
  // wrapper propagation
  //

  function visit(
    node: ts.Node,
  ): void {

    if (
      ts.isCallExpression(
        node,
      )
    ) {

      extractPropagationEvents(

        node,

        checker,

        wrapperRegistry,

        resolvedCallCache,

        evaluationCache,

        exportCache,

        events,

        new Set(),
      );
    }

    ts.forEachChild(
      node,
      visit,
    );
  }

  visit(
    index.sourceFile,
  );

  return {

    events,

    detectedFunctionWrappers:
      new Set(
        index.wrappers.map(
          wrapper =>
            wrapper.symbol.getName(),
        ),
      ),

    detectedComponentWrappers:
      new Map(),
  };
}
