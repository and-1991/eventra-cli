import ts from "typescript";

import { isAngularInput } from "../symbols/angularInput";
import { unwrapExpression } from "./utils";

/**
 * Where a dynamic event name stands:
 * - `wrapper`: the name is a parameter (or a prop) of the function the call sits in, so the function is a
 *   wrapper and what it tracks is whatever each caller passes; the callers are checked on their own.
 * - `unresolved`: the name is not known where the call is made: the one a real event may be missing for.
 */
export type DynamicKind = "wrapper" | "unresolved";

/** Why an unresolved name is not known; `parameter` is the cause of a wrapper's call. */
export type DynamicCause = "parameter" | "env" | "variable" | "template" | "call" | "expression" | "callback";

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

// calls that hand a function to code that calls it with values this scan cannot see: the items of a list,
// the event of a listener, the result of a promise
const CALLBACK_APIS = new Set([
  "forEach", "map", "flatMap", "filter", "reduce", "reduceRight", "some", "every", "find", "findIndex", "findLast",
  "findLastIndex", "addEventListener", "on", "once", "subscribe", "then", "catch", "finally", "each", "listen",
  "observe", "setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask",
]);

/** A parameter of a function written in place as an argument of `forEach`, `map`, `addEventListener` and the like. */
function isInlineCallbackParameter(declaration: ts.Declaration): boolean {
  let node: ts.Node = declaration;
  // a binding element sits in a binding pattern, which always has a parent
  while (ts.isBindingElement(node)) {
    node = node.parent.parent;
  }
  if (!ts.isParameter(node)) return false;
  const fn = node.parent;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(fn)) return false;
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
  return name !== undefined && CALLBACK_APIS.has(name);
}

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

/** `this.props`, `this.props.a`, `this.props.a.b`: a read of a class component's props. */
function readsThisProps(expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current)) {
    const owner = unwrapExpression(current.expression);
    if (current.name.text === "props" && owner.kind === ts.SyntaxKind.ThisKeyword) return true;
    current = owner;
  }
  return false;
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
  // `this.name` / `this.name()` where `name` is an input of an Angular component: what the parent passes in, so the
  // call is a wrapper's, like the parameter of a function
  const inputRead = ts.isCallExpression(expr) && expr.arguments.length === 0 ? unwrapExpression(expr.expression) : expr;
  if (ts.isPropertyAccessExpression(inputRead) && inputRead.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const member = checker.getSymbolAtLocation(inputRead.name)?.valueDeclaration;
    if (member && isAngularInput(member)) return WRAPPER;
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
    // a class component reads its props as `this.props.x`, or takes the whole object (`const { x } = this.props`)
    return readsThisProps(expr) ? WRAPPER : unresolved("variable");
  }
  if (!ts.isIdentifier(root)) {
    return unresolved("expression");
  }
  const declarations = checker.getSymbolAtLocation(root)?.getDeclarations() ?? [];
  if (declarations.some((declaration) => ts.isParameter(declaration) || isParameterBinding(declaration))) {
    // not a wrapper: nothing calls this function with a value the scan could read, so the name stays unknown
    if (declarations.some(isInlineCallbackParameter)) return unresolved("callback");
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
