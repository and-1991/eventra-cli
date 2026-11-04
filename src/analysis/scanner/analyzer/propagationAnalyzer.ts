import ts from "typescript";

import {TrackSink, WrapperPropagation, WrapperSemanticInfo} from "../../shared/propagation";
import {getFunctionSymbol} from "../../symbols/symbolUtils";
import {unwrapExpression, getPropertyName} from "../../shared/utils";
import {callSiteArgument} from "../../shared/callSite";
import {classPropsParameter, componentClassOfRender, thisPropsPath} from "../../symbols/classComponent";

interface ResolvedParameterBinding {
  readonly parameter: ts.ParameterDeclaration;
  readonly propertyPath: readonly string[];
  // `...rest` of the parameter's pattern: the props it holds are every one but these, which are read by name
  readonly omitted?: readonly string[];
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
    // `{ a, ...rest }`: `rest` holds the props at this level that are not named beside it
    if (element.dotDotDotToken) {
      if (ts.isIdentifier(element.name) && element.name.text === identifier.text) {
        const omitted = pattern.elements.flatMap((other) => (other.dotDotDotToken ? [] : [bindingKey(other) ?? ""]));
        return {parameter, propertyPath: parentPath, omitted};
      }
      continue;
    }
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

/** What is read off a `...rest` can only be a prop that the pattern did not name. */
const readable = (binding: ResolvedParameterBinding, tail: readonly string[]): boolean =>
  !binding.omitted || tail.length === 0 || !binding.omitted.includes(tail[0]);

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
  const cls = componentClassOfRender(fn);
  const scope: ts.Node | undefined = cls ?? fn.body;
  if (!scope || node.pos < scope.pos || node.end > scope.end) {
    return null;
  }
  const initializer = unwrapExpression(node.initializer);
  // `const { name } = this.props` in a class component
  const classPath = cls && thisPropsPath(initializer, true);
  if (cls && classPath) {
    return {parameter: classPropsParameter(cls), propertyPath: [...classPath, ...pattern], viaAlias: true};
  }
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
  const tail = [...readPath, ...pattern];
  if (!readable(base, tail)) {
    return null;
  }
  return {parameter: base.parameter, propertyPath: [...base.propertyPath, ...tail], viaAlias: true, ...(tail.length === 0 && base.omitted ? {omitted: base.omitted} : {})};
}

function resolveParameter(fn: ts.FunctionLikeDeclaration, identifier: ts.Identifier, checker: ts.TypeChecker): ResolvedParameterBinding | null {
  return resolveDirectParameter(fn, identifier) ?? resolveLocalAlias(fn, identifier, checker, 0);
}

// a class component's props stand in for a parameter that is not in the list
const parameterIndex = (fn: ts.FunctionLikeDeclaration, parameter: ts.ParameterDeclaration): number => Math.max(0, fn.parameters.indexOf(parameter));

/** `this.props.name` in a class component: the props parameter and the path read off it. */
function classPropRead(fn: ts.FunctionLikeDeclaration, expression: ts.Expression): ResolvedParameterBinding | null {
  const cls = componentClassOfRender(fn);
  const path = cls && thisPropsPath(expression);
  return cls && path ? {parameter: classPropsParameter(cls), propertyPath: path, viaAlias: true} : null;
}

/**
 * What a spread forwards: `{...props}`, `{...props.rest}`, `{...this.props}`. The parameter (or the class's
 * props) it reads and the path from there, or null when it is anything else.
 */
function spreadSource(fn: ts.FunctionLikeDeclaration, expression: ts.Expression, checker: ts.TypeChecker): ResolvedParameterBinding | null {
  const cls = componentClassOfRender(fn);
  const classPath = cls && thisPropsPath(expression, true);
  if (cls && classPath) {
    return {parameter: classPropsParameter(cls), propertyPath: classPath, viaAlias: true};
  }
  const path = extractPropertyPath(expression);
  let root: ts.Expression = unwrapExpression(expression);
  while (isPropertyAccessLike(root)) {
    root = unwrapExpression(root.expression);
  }
  const base = path && ts.isIdentifier(root) ? resolveParameter(fn, root, checker) : null;
  return base && readable(base, path!) ? {parameter: base.parameter, propertyPath: [...base.propertyPath, ...path!], viaAlias: true, ...(path!.length === 0 && base.omitted ? {omitted: base.omitted} : {})} : null;
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
      const classRead = classPropRead(fn, argument);
      if (classRead) {
        result.push({sourceParameter: classRead.parameter, sourceParameterIndex: 0, propertyPath: classRead.propertyPath, targetNode: argument, viaAlias: true});
        continue;
      }
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
        if (!parameter || !readable(parameter, propertyPath)) {
          continue;
        }

        result.push({
          sourceParameter: parameter.parameter,
          sourceParameterIndex: parameterIndex(fn, parameter.parameter),
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
        for (const [position, property] of argument.properties.entries()) {
          // `{ ...props }` / `<Inner {...props} />`: the name the sink reads is the one the spread carries, unless
          // a property written after it sets the same name
          if (ts.isSpreadAssignment(property)) {
            const name = tracked.propertyPath[0];
            const overridden = argument.properties.slice(position + 1).some((later) => (ts.isPropertyAssignment(later) || ts.isShorthandPropertyAssignment(later)) && later.name.getText() === name);
            const found = name !== undefined && !overridden ? spreadSource(fn, property.expression, checker) : null;
            // a `...rest` does not hold the props named beside it
            const source = found && readable(found, tracked.propertyPath) ? found : null;
            if (source) {
              result.push({
                sourceParameter: source.parameter,
                sourceParameterIndex: parameterIndex(fn, source.parameter),
                propertyPath: [...source.propertyPath, ...tracked.propertyPath],
                targetNode: property.expression,
                viaAlias: true,
              });
            }
            continue;
          }
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            continue;
          }
          // The sink only reads one property (e.g. `event`) as the name; `{ distinctId, event }`
          // must not propagate `distinctId` as an event name too.
          if (tracked.propertyPath.length > 0 && property.name.getText() !== tracked.propertyPath[0]) {
            continue;
          }
          const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : unwrapExpression(property.initializer);
          const classPropertyRead = classPropRead(fn, initializer);
          if (classPropertyRead) {
            result.push({sourceParameter: classPropertyRead.parameter, sourceParameterIndex: 0, propertyPath: classPropertyRead.propertyPath, targetNode: initializer, viaAlias: true});
            continue;
          }
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
          if (!parameter || !readable(parameter, readPath)) {
            continue;
          }
          result.push({
            sourceParameter: parameter.parameter,
            sourceParameterIndex: parameterIndex(fn, parameter.parameter),
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
