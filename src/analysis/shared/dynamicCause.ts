import ts from "typescript";

import { unwrapExpression } from "./utils";

/**
 * Where a dynamic event name stands:
 * - `wrapper`: the name is a parameter (or a prop) of the function the call sits in, so the function is a
 *   wrapper and what it tracks is whatever each caller passes; the callers are checked on their own.
 * - `unresolved`: the name is not known where the call is made: the one a real event may be missing for.
 */
export type DynamicKind = "wrapper" | "unresolved";

/** Why an unresolved name is not known; `parameter` is the cause of a wrapper's call. */
export type DynamicCause = "parameter" | "env" | "variable" | "template" | "call" | "expression";

export interface DynamicClassification {
  readonly kind: DynamicKind;
  readonly cause: DynamicCause;
}

const MAX_HOPS = 3;
const ENV_ACCESS = /^(?:process\.env|import\.meta\.env|Bun\.env|Deno\.env)\b/;

const WRAPPER: DynamicClassification = { kind: "wrapper", cause: "parameter" };
const unresolved = (cause: DynamicCause): DynamicClassification => ({ kind: "unresolved", cause });

// a node built by the analysis itself has no text to read
const hasText = (node: ts.Node): boolean => node.pos >= 0 && node.parent !== undefined;

function isParameterBinding(declaration: ts.Declaration): boolean {
  let node: ts.Node | undefined = declaration;
  while (node && ts.isBindingElement(node)) {
    node = node.parent?.parent;
  }
  return node !== undefined && ts.isParameter(node);
}

/** `a.b.c` / `a?.b` / `a[k]` -> `a`; `this.props.x` has the root `this`. */
function rootOf(expression: ts.Expression): ts.Expression {
  let root = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
    root = unwrapExpression(root.expression);
  }
  return root;
}

/**
 * Sorts a dynamic event-name expression into a kind and a cause, so a call inside a wrapper is not told
 * apart from a real gap only by being on the same list.
 */
export function classifyDynamic(expression: ts.Expression, checker: ts.TypeChecker, hops = 0): DynamicClassification {
  let expr = unwrapExpression(expression);
  if (ts.isAwaitExpression(expr)) {
    expr = unwrapExpression(expr.expression);
  }
  if (hasText(expr) && ENV_ACCESS.test(expr.getText())) {
    return unresolved("env");
  }
  if (ts.isTemplateExpression(expr)) {
    return unresolved("template");
  }
  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
    return unresolved("call");
  }
  const root = rootOf(expr);
  if (root.kind === ts.SyntaxKind.ThisKeyword) {
    // a class component reads its props as `this.props.x`
    const isProps = ts.isPropertyAccessExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "props";
    return isProps ? WRAPPER : unresolved("variable");
  }
  if (!ts.isIdentifier(root)) {
    return unresolved("expression");
  }
  const declarations = checker.getSymbolAtLocation(root)?.getDeclarations() ?? [];
  if (declarations.some((declaration) => ts.isParameter(declaration) || isParameterBinding(declaration))) {
    return WRAPPER;
  }
  // `const name = process.env.X` / `const { a } = props`: the answer is in what the constant is set from
  if (hops < MAX_HOPS) {
    for (const declaration of declarations) {
      const owner = ts.isBindingElement(declaration) ? ts.findAncestor(declaration, ts.isVariableDeclaration) : declaration;
      if (owner && ts.isVariableDeclaration(owner) && owner.initializer && (ts.getCombinedNodeFlags(owner) & ts.NodeFlags.Const) !== 0) {
        const origin = classifyDynamic(owner.initializer, checker, hops + 1);
        // a plain value of its own (an object, a literal) says nothing more than "a variable"
        if (origin.kind === "wrapper" || origin.cause !== "expression") {
          return origin;
        }
      }
    }
  }
  // what is left is a name or a property path of one: a variable with no known value
  return unresolved("variable");
}
