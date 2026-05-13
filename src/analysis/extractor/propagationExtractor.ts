// src/analysis/extractor/propagationExtractor.ts

import ts from "typescript";

import {
  resolveFunctionFromCall,
} from "../resolver/callResolver";

import {
  resolveNodeValue,
} from "../resolver/resolver";

import {
  createEvaluationContext,
} from "../shared/evaluationContext";

import {
  WrapperRegistry,
} from "../symbols/wrapperRegistry";

import {
  WrapperPropagation,
} from "../shared/propagation";

import {
  ResolvedCallCache,
} from "../cache/resolvedCallCache";

import {
  ResolvedExportCache,
} from "../cache/resolvedExportCache";

import {
  EvaluationCache,
} from "../cache/evaluationCache";

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

export function extractPropagationEvents(
  call: ts.CallExpression,

  checker: ts.TypeChecker,

  wrapperRegistry:
  WrapperRegistry,

  resolvedCallCache:
  ResolvedCallCache,

  evaluationCache:
  EvaluationCache,

  exportCache:
  ResolvedExportCache,

  events:
  Set<string>,

  visited:
  Set<ts.Signature>,
): void {

  const resolved =
    resolveFunctionFromCall(

      call.expression,

      checker,

      resolvedCallCache,

      exportCache,
    );

  if (!resolved) {

    return;
  }

  const semantic =
    wrapperRegistry.get(

      resolved,

      checker,

      exportCache,
    );

  if (!semantic) {

    return;
  }

  const signature =
    checker.getSignatureFromDeclaration(
      resolved,
    );

  if (!signature) {

    return;
  }

  if (
    visited.has(
      signature,
    )
  ) {

    return;
  }

  visited.add(
    signature,
  );

  for (
    const propagation
    of semantic.propagations
    ) {

    extractPropagation(

      propagation,

      call,

      checker,

      evaluationCache,

      resolvedCallCache,

      exportCache,

      events,
    );
  }
}

function extractPropagation(
  propagation:
  WrapperPropagation,

  call:
  ts.CallExpression,

  checker:
  ts.TypeChecker,

  evaluationCache:
  EvaluationCache,

  resolvedCallCache:
  ResolvedCallCache,

  exportCache:
  ResolvedExportCache,

  events:
  Set<string>,
): void {

  const argument =
    call.arguments[
      propagation.sourceParameterIndex
      ];

  if (!argument) {

    return;
  }

  const context =
    createEvaluationContext();

  const parameterSymbol =
    checker.getSymbolAtLocation(
      propagation
        .sourceParameter
        .name,
    );

  if (
    parameterSymbol
  ) {

    context.parameterBindings.set(
      parameterSymbol,
      argument,
    );
  }

  const resolved =
    resolveNodeValue(

      propagation.targetNode,

      checker,

      context,

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
