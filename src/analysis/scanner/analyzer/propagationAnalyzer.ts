import ts from "typescript";

import {TrackSink, WrapperPropagation, WrapperSemanticInfo} from "../../shared/propagation";
import {getFunctionSymbol} from "../../symbols/symbolUtils";
import {unwrapExpression, getPropertyName} from "../../shared/utils";
import {callSiteArgument} from "../../shared/callSite";

interface ResolvedParameterBinding {
  readonly parameter: ts.ParameterDeclaration;
  readonly propertyPath: readonly string[];
  // reached through a local `const` (`const { track } = props`) instead of the parameter itself
  readonly viaAlias?: boolean;
}

function isPropertyAccessLike(node: ts.Expression): node is ts.PropertyAccessExpression | ts.PropertyAccessChain | ts.ElementAccessExpression {
  return ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node) || ts.isElementAccessExpression(node);
}

function extractPropertyPath(expression: ts.Expression): readonly string[] | null {
  const result: string[] = [];
  let current: ts.Expression = unwrapExpression(expression);
  while (isPropertyAccessLike(current)) {
    const propertyName = getPropertyName(current);
    if (!propertyName) {
      return null;
    }
    result.unshift(propertyName);
    current = unwrapExpression(current.expression);
  }
  if (!ts.isIdentifier(current)) {
    return null;
  }

  return result;
}

/** The property a binding element reads: `{ a }` and `{ a: x }` read `a`, `{ "a-b": x }` reads `a-b`, a computed key reads nothing known. */
function bindingKey(element: ts.BindingElement): string | null {
  const key = element.propertyName;
  if (!key) {
    return ts.isIdentifier(element.name) ? element.name.text : null;
  }
  return ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key) ? key.text : null;
}

function resolveObjectBinding(parameter: ts.ParameterDeclaration, pattern: ts.ObjectBindingPattern, identifier: ts.Identifier, parentPath: readonly string[]): ResolvedParameterBinding | null {
  for (const element of pattern.elements) {
    const propertyName = bindingKey(element);
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

function resolveDirectParameter(fn: ts.FunctionLikeDeclaration, identifier: ts.Identifier): ResolvedParameterBinding | null {
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

const MAX_ALIAS_HOPS = 4;

function isConstVariable(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

/**
 * A local `const` that only renames part of a parameter: `const { track } = props`, `const p = props`,
 * `const name = props.track`. The name then reads the same value as the parameter path it was taken from.
 * Only `const` declared inside `fn` itself counts: a `let` can be reassigned, and a name from an outer
 * scope is not this function's input.
 */
function resolveLocalAlias(fn: ts.FunctionLikeDeclaration, identifier: ts.Identifier, checker: ts.TypeChecker, hops: number): ResolvedParameterBinding | null {
  if (hops >= MAX_ALIAS_HOPS) {
    return null;
  }
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (!declaration) {
    return null;
  }
  // `const { a: { b } } = props` -> the names from the variable down to this binding
  const pattern: string[] = [];
  let node: ts.Node = declaration;
  while (ts.isBindingElement(node)) {
    if (node.dotDotDotToken) {
      return null;
    }
    const name = bindingKey(node);
    if (!name) {
      return null;
    }
    pattern.unshift(name);
    const parent: ts.Node = node.parent;
    if (!ts.isObjectBindingPattern(parent)) {
      return null;
    }
    node = parent.parent;
  }
  if (!ts.isVariableDeclaration(node) || !node.initializer || !isConstVariable(node)) {
    return null;
  }
  if (!fn.body || node.pos < fn.body.pos || node.end > fn.body.end) {
    return null;
  }
  const initializer = unwrapExpression(node.initializer);
  let root: ts.Expression = initializer;
  let readPath: readonly string[] = [];
  if (isPropertyAccessLike(initializer)) {
    readPath = extractPropertyPath(initializer) ?? [];
    while (isPropertyAccessLike(root)) {
      root = unwrapExpression(root.expression);
    }
  }
  if (!ts.isIdentifier(root)) {
    return null;
  }
  const base = resolveDirectParameter(fn, root) ?? resolveLocalAlias(fn, root, checker, hops + 1);
  if (!base) {
    return null;
  }
  return {parameter: base.parameter, propertyPath: [...base.propertyPath, ...readPath, ...pattern], viaAlias: true};
}

function resolveParameter(fn: ts.FunctionLikeDeclaration, identifier: ts.Identifier, checker: ts.TypeChecker): ResolvedParameterBinding | null {
  return resolveDirectParameter(fn, identifier) ?? resolveLocalAlias(fn, identifier, checker, 0);
}

function collectPropagations(fn: ts.FunctionLikeDeclaration, sinks: readonly TrackSink[], checker: ts.TypeChecker,): readonly WrapperPropagation[] {
  const result: WrapperPropagation[] = [];
  for (const sink of sinks) {
    for (const tracked of sink.trackedArguments) {
      const rawArgument = callSiteArgument(sink.call, tracked.index);
      if (!rawArgument) {
        continue;
      }
      const argument = unwrapExpression(rawArgument);
      // direct parameter
      // track(name)
      // track(props.event)
      // track(props?.event)
      // track(props?.event as string)
      // track(props["event"])
      if (ts.isIdentifier(argument) || isPropertyAccessLike(argument)) {
        let identifier: ts.Identifier | null = null;
        let propertyPath: readonly string[] = [];
        if (ts.isIdentifier(argument,)) {
          identifier = argument;
        } else {
          propertyPath = extractPropertyPath(argument) ?? [];
          let root: ts.Expression = argument;
          while (isPropertyAccessLike(root)) {
            root = unwrapExpression(root.expression);
          }
          if (ts.isIdentifier(root)) {
            identifier = root;
          }
        }
        if (!identifier) {
          continue;
        }
        const parameter = resolveParameter(fn, identifier, checker);
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
          ...(parameter.viaAlias ? {viaAlias: true} : {}),
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
          // The sink only reads one property (e.g. `event`) as the name; `{ distinctId, event }`
          // must not propagate `distinctId` as an event name too.
          if (tracked.propertyPath.length > 0 && property.name.getText() !== tracked.propertyPath[0]) {
            continue;
          }
          const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : unwrapExpression(property.initializer);
          // `{ event: name }` / `<Inner name={track} />`, and a read of a prop: `<Inner name={props.track} />`
          let identifier: ts.Identifier | null = null;
          let readPath: readonly string[] = [];
          if (ts.isIdentifier(initializer)) {
            identifier = initializer;
          } else if (isPropertyAccessLike(initializer)) {
            readPath = extractPropertyPath(initializer) ?? [];
            let root: ts.Expression = initializer;
            while (isPropertyAccessLike(root)) {
              root = unwrapExpression(root.expression);
            }
            identifier = ts.isIdentifier(root) ? root : null;
          }
          if (!identifier) {
            continue;
          }
          const parameter = resolveParameter(fn, identifier, checker);
          if (!parameter) {
            continue;
          }
          result.push({
            sourceParameter: parameter.parameter,
            sourceParameterIndex: fn.parameters.indexOf(parameter.parameter),
            propertyPath: [...parameter.propertyPath, ...readPath],
            targetNode: initializer,
            ...(parameter.viaAlias ? {viaAlias: true} : {}),
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
  const propagations = collectPropagations(fn, sinks, checker);
  if (propagations.length === 0) {
    return null;
  }
  return {
    symbol,
    declaration: fn,
    propagations,
  };
}
