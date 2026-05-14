import ts from "typescript";

export interface ReturnPropagation {
  readonly parameter: ts.ParameterDeclaration;
  readonly parameterIndex: number;
  readonly returnExpression: ts.Expression;
}

export interface ReturnSemanticInfo {
  readonly declaration: ts.FunctionLikeDeclaration;
  readonly propagations: readonly ReturnPropagation[];
}
