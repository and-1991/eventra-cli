import ts from "typescript";

import {TrackSink, WrapperPropagation, WrapperSemanticInfo} from "../../shared/propagation";
import {getFunctionSymbol} from "../../symbols/symbolUtils";

interface ResolvedParameterBinding {
  readonly parameter: ts.ParameterDeclaration;
  readonly propertyPath: readonly string[];
}

function extractPropertyPath(expression: ts.Expression): readonly string[] | null {
  const result: string[] = [];
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
    result.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) {
    return null;
  }

  return result;
}

function resolveObjectBinding(parameter: ts.ParameterDeclaration, pattern: ts.ObjectBindingPattern, identifier: ts.Identifier, parentPath: readonly string[]): ResolvedParameterBinding | null {
  for (const element of pattern.elements) {
    const propertyName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null;
    if (!propertyName) {
      continue;
    }
    const nextPath = [
      ...parentPath,
      propertyName,
    ];
    // alias:
    // { event: name }
    if (ts.isIdentifier(element.name)) {
      if (element.name.text === identifier.text) {
        return {
          parameter,
          propertyPath: nextPath,
        };
      }
    }
    // nested:
    // { meta: { event }
    if (ts.isObjectBindingPattern(element.name)) {
      const nested = resolveObjectBinding(parameter, element.name, identifier, nextPath);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function resolveParameter(fn: ts.FunctionLikeDeclaration, identifier: ts.Identifier): ResolvedParameterBinding | null {
  for (const parameter of fn.parameters) {
    // simple param
    // function x(name)
    if (ts.isIdentifier(parameter.name,)) {
      if (parameter.name.text === identifier.text) {
        return {
          parameter,
          propertyPath: [],
        };
      }
      continue;
    }
    // destructuring
    // function x({ event })
    if (ts.isObjectBindingPattern(parameter.name,)) {
      const resolved = resolveObjectBinding(parameter, parameter.name, identifier, []);
      if (resolved) {
        return resolved;
      }
    }
  }
  return null;
}

function collectPropagations(fn: ts.FunctionLikeDeclaration, sinks: readonly TrackSink[],): readonly WrapperPropagation[] {
  const result: WrapperPropagation[] = [];
  for (const sink of sinks) {
    for (const tracked of sink.trackedArguments) {
      const argument = sink.call.arguments[tracked.index];
      if (!argument) {
        continue;
      }
      // direct parameter
      // track(name)
      // track(props.event)
      // track(props?.event)
      if (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument) || ts.isPropertyAccessChain(argument)) {
        let identifier: ts.Identifier | null = null;
        let propertyPath: readonly string[] = [];
        if (ts.isIdentifier(argument,)) {
          identifier = argument;
        } else {
          propertyPath = extractPropertyPath(argument) ?? [];
          let root: ts.Expression = argument;
          while (ts.isPropertyAccessExpression(root) || ts.isPropertyAccessChain(root)) {
            root = root.expression;
          }
          if (ts.isIdentifier(root)) {
            identifier = root;
          }
        }
        if (!identifier) {
          continue;
        }
        const parameter = resolveParameter(fn, identifier);
        if (!parameter) {
          continue;
        }

        result.push({
          sourceParameter: parameter.parameter,
          sourceParameterIndex: fn.parameters.indexOf(parameter.parameter),
          propertyPath: [
            ...parameter.propertyPath,
            ...propertyPath,
          ],
          targetNode: argument,
        });
        continue;
      }
      // object literal
      // track({ event: name })
      // track({ event })
      if (ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            continue;
          }
          const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
          if (!ts.isIdentifier(initializer)) {
            continue;
          }
          const parameter = resolveParameter(fn, initializer);
          if (!parameter) {
            continue;
          }
          result.push({
            sourceParameter: parameter.parameter,
            sourceParameterIndex: fn.parameters.indexOf(parameter.parameter),
            propertyPath: parameter.propertyPath,
            targetNode: initializer,
          });
        }
      }
    }
  }
  return result;
}

export function analyzeWrapperPropagation(fn: ts.FunctionLikeDeclaration, checker: ts.TypeChecker, sinks: readonly TrackSink[],): WrapperSemanticInfo | null {
  const symbol = getFunctionSymbol(fn, checker);
  if (!symbol) {
    return null;
  }
  const propagations = collectPropagations(fn, sinks);
  if (propagations.length === 0) {
    return null;
  }
  return {
    symbol,
    declaration: fn,
    propagations,
  };
}
