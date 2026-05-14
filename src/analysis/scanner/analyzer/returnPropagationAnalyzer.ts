import ts from "typescript";

import {ReturnPropagation, ReturnSemanticInfo} from "../../shared/returnPropagation";

function resolveParameter(fn: ts.FunctionLikeDeclaration, identifier: ts.Identifier): ts.ParameterDeclaration | null {
  for (const parameter of fn.parameters) {
    if (!ts.isIdentifier(parameter.name)) {
      continue;
    }
    if (parameter.name.text === identifier.text) {
      return parameter;
    }
  }
  return null;
}

export function analyzeReturnPropagation(fn: ts.FunctionLikeDeclaration): ReturnSemanticInfo | null {
  const propagations: ReturnPropagation[] = [];

  function visit(node: ts.Node): void {
    // return value
    if (ts.isReturnStatement(node) && node.expression) {
      collectExpression(node.expression);
    }
    ts.forEachChild(node, visit);
  }

  function collectExpression(expression: ts.Expression): void {
    // direct return
    // return event
    if (ts.isIdentifier(expression)) {
      const parameter = resolveParameter(fn, expression);
      if (!parameter) {
        return;
      }
      propagations.push({
        parameter,
        parameterIndex: fn.parameters.indexOf(parameter),
        returnExpression: expression,
      });
      return;
    }
    // object return
    // return { event }
    if (ts.isObjectLiteralExpression(expression,)) {
      for (const property of expression.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const initializer = property.initializer;
        if (!ts.isIdentifier(initializer)) {
          continue;
        }
        const parameter = resolveParameter(fn, initializer);
        if (!parameter) {
          continue;
        }
        propagations.push({
          parameter,
          parameterIndex: fn.parameters.indexOf(parameter),
          returnExpression: initializer,
        });
      }
      return;
    }
    // template returns
    if (ts.isTemplateExpression(expression,)) {
      for (const span of expression.templateSpans) {
        if (!ts.isIdentifier(span.expression,)) {
          continue;
        }
        const parameter = resolveParameter(fn, span.expression);
        if (!parameter) {
          continue;
        }
        propagations.push({
          parameter,
          parameterIndex: fn.parameters.indexOf(parameter),
          returnExpression: expression,
        });
      }
    }
  }

  if (fn.body) {
    visit(fn.body);
  }
  if (propagations.length === 0) {
    return null;
  }

  return {
    declaration:
    fn,
    propagations,
  };
}
