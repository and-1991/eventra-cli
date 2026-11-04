import ts from "typescript";

import {unwrapExpression} from "../shared/utils";

const COMPONENT_BASES = new Set(["Component", "PureComponent"]);

/** `extends Component<P>`, `extends React.PureComponent<P>`: a React class component. */
export function isReactClassComponent(cls: ts.ClassLikeDeclaration): boolean {
  const base = cls.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  if (!base) {
    return false;
  }
  const name = ts.isIdentifier(base) ? base.text : ts.isPropertyAccessExpression(base) ? base.name.text : undefined;
  return name !== undefined && COMPONENT_BASES.has(name);
}

/** The `render()` of a React class component: the function a JSX use of the class is the call of. */
export function renderMethodOf(cls: ts.ClassLikeDeclaration): ts.MethodDeclaration | null {
  if (!isReactClassComponent(cls)) {
    return null;
  }
  return cls.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "render") ?? null;
}

/** The class when `fn` is the `render()` of a React class component, else null. */
export function componentClassOfRender(fn: ts.FunctionLikeDeclaration): ts.ClassLikeDeclaration | null {
  const cls = fn.parent;
  return ts.isMethodDeclaration(fn) && (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && renderMethodOf(cls) === fn ? cls : null;
}

// A class component reads its props as `this.props`, not through a parameter. This stands in for the
// parameter, so a use of the class (`<C name="x" />`) can be followed like a call of a function of props.
const propsParameters = new WeakMap<ts.Node, ts.ParameterDeclaration>();

export function classPropsParameter(cls: ts.ClassLikeDeclaration): ts.ParameterDeclaration {
  let parameter = propsParameters.get(cls);
  if (!parameter) {
    parameter = ts.factory.createParameterDeclaration(undefined, undefined, "props");
    propsParameters.set(cls, parameter);
  }
  return parameter;
}

/**
 * `this.props.a.b` -> ["a", "b"]; null when the expression is not a read of the props. The whole object
 * (`this.props`) is a read of the props too, with an empty path, only when `allowWhole` says so: a track
 * call cannot take the whole object as an event name, but `const { name } = this.props` can.
 */
export function thisPropsPath(expression: ts.Expression, allowWhole = false): readonly string[] | null {
  const path: string[] = [];
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const name = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : current.argumentExpression && ts.isStringLiteralLike(current.argumentExpression)
        ? current.argumentExpression.text
        : null;
    if (name === null) {
      return null;
    }
    path.unshift(name);
    current = unwrapExpression(current.expression);
  }
  return current.kind === ts.SyntaxKind.ThisKeyword && path[0] === "props" && (allowWhole || path.length > 1) ? path.slice(1) : null;
}
