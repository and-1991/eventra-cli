// src/analysis/resolver/resolver.ts

import ts from "typescript";

import {
  resolveExportedSymbol,
} from "./exportResolver";

import {
  EvaluationCache,
} from "../cache/evaluationCache";

import {
  ResolvedExportCache,
} from "../cache/resolvedExportCache";

import {
  EvaluationContext,
} from "../shared/evaluationContext";

import {
  analyzeReturnPropagation,
} from "../scanner/analyzer/returnPropagationAnalyzer";

import {
  resolveFunctionFromCall,
} from "./callResolver";

import {
  ResolvedCallCache,
} from "../cache/resolvedCallCache";

export interface ResolveResult {

  readonly values:
    readonly string[];

  readonly dynamic:
    boolean;
}

function unique(
  values: readonly string[],
): string[] {

  return [
    ...new Set(values),
  ];
}

function empty():
  ResolveResult {

  return {

    values: [],

    dynamic: true,
  };
}

function concat(
  left: readonly string[],
  right: readonly string[],
): string[] {

  const result:
    string[] = [];

  for (
    const l
    of left
    ) {

    for (
      const r
      of right
      ) {

      result.push(
        l + r,
      );
    }
  }

  return unique(
    result,
  );
}

function resolveIdentifier(
  node: ts.Identifier,

  checker: ts.TypeChecker,

  context:
  EvaluationContext,

  visited:
  Set<ts.Node>,

  evaluationCache:
  EvaluationCache,

  exportCache:
  ResolvedExportCache,
): ResolveResult {

  const boundSymbol =
    checker.getSymbolAtLocation(
      node,
    );

  if (
    boundSymbol
    && context.parameterBindings.has(
      boundSymbol,
    )
  ) {

    const bound =
      context.parameterBindings.get(
        boundSymbol,
      );

    if (bound) {

      return resolveNodeValue(

        bound,

        checker,

        context,

        visited,

        evaluationCache,

        undefined,

        exportCache,
      );
    }
  }

  let symbol =
    checker.getSymbolAtLocation(
      node,
    );

  if (!symbol) {

    return empty();
  }

  symbol =
    resolveExportedSymbol(
      symbol,
      checker,
      exportCache,
    )
    ?? symbol;

  const cached =
    evaluationCache.get(
      symbol,
    );

  if (cached) {

    return cached;
  }

  const resolving =
    empty();

  evaluationCache.set(
    symbol,
    resolving,
  );

  const declarations =
    symbol.getDeclarations()
    ?? [];

  for (
    const declaration
    of declarations
    ) {

    if (
      ts.isVariableDeclaration(
        declaration,
      )
      && declaration.initializer
    ) {

      const resolved =
        resolveNodeValue(

          declaration.initializer,

          checker,

          context,

          visited,

          evaluationCache,

          undefined,

          exportCache,
        );

      evaluationCache.set(
        symbol,
        resolved,
      );

      return resolved;
    }
  }

  return resolving;
}

function resolveCallExpression(
  node: ts.CallExpression,

  checker: ts.TypeChecker,

  context:
  EvaluationContext,

  visited:
  Set<ts.Node>,

  evaluationCache:
  EvaluationCache,

  resolvedCallCache:
    ResolvedCallCache
    | undefined,

  exportCache:
  ResolvedExportCache,
): ResolveResult {

  const resolved =
    resolveFunctionFromCall(

      node.expression,

      checker,

      resolvedCallCache
      ?? new ResolvedCallCache(),

      exportCache,
    );

  if (!resolved) {

    return empty();
  }

  const semantic =
    analyzeReturnPropagation(
      resolved,
    );

  if (!semantic) {

    return empty();
  }

  const values:
    string[] = [];

  for (
    const propagation
    of semantic.propagations
    ) {

    const argument =
      node.arguments[
        propagation.parameterIndex
        ];

    if (!argument) {

      continue;
    }

    const nextContext = {

      parameterBindings:
        new Map(
          context.parameterBindings,
        ),
    };

    const parameterSymbol =
      checker.getSymbolAtLocation(
        propagation.parameter.name,
      );

    if (
      parameterSymbol
    ) {

      nextContext.parameterBindings.set(
        parameterSymbol,
        argument,
      );
    }

    const resolvedValue =
      resolveNodeValue(

        propagation.returnExpression,

        checker,

        nextContext,

        new Set(visited),

        evaluationCache,

        resolvedCallCache,

        exportCache,
      );

    values.push(
      ...resolvedValue.values,
    );
  }

  return {

    values:
      unique(values),

    dynamic: true,
  };
}

export function resolveNodeValue(
  node: ts.Node,

  checker: ts.TypeChecker,

  context:
  EvaluationContext,

  visited:
  Set<ts.Node>,

  evaluationCache:
  EvaluationCache,

  resolvedCallCache:
    ResolvedCallCache
    | undefined,

  exportCache:
  ResolvedExportCache,
): ResolveResult {

  if (
    visited.has(node)
  ) {

    return empty();
  }

  visited.add(
    node,
  );

  try {

    if (
      ts.isStringLiteral(node)
    ) {

      return {

        values: [
          node.text,
        ],

        dynamic: false,
      };
    }

    if (
      ts.isIdentifier(node)
    ) {

      return resolveIdentifier(

        node,

        checker,

        context,

        visited,

        evaluationCache,

        exportCache,
      );
    }

    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind
      === ts.SyntaxKind.PlusToken
    ) {

      const left =
        resolveNodeValue(

          node.left,

          checker,

          context,

          visited,

          evaluationCache,

          resolvedCallCache,

          exportCache,
        );

      const right =
        resolveNodeValue(

          node.right,

          checker,

          context,

          visited,

          evaluationCache,

          resolvedCallCache,

          exportCache,
        );

      return {

        values:
          concat(
            left.values,
            right.values,
          ),

        dynamic: true,
      };
    }

    if (
      ts.isCallExpression(
        node,
      )
    ) {

      return resolveCallExpression(

        node,

        checker,

        context,

        visited,

        evaluationCache,

        resolvedCallCache,

        exportCache,
      );
    }

    return empty();
  }

  finally {

    visited.delete(
      node,
    );
  }
}
