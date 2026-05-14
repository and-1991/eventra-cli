import ts from "typescript";

export interface EvaluationContext {
  readonly parameterBindings: Map<ts.Symbol, ts.Expression>;
}

export function createEvaluationContext():
  EvaluationContext {
  return {
    parameterBindings: new Map(),
  };
}
