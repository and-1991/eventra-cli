import ts from "typescript";

import {resolveExportedSymbol} from "./exportResolver";
import {EvaluationCache} from "../cache/evaluationCache";
import {ResolvedExportCache} from "../cache/resolvedExportCache";
import {EvaluationContext} from "../shared/evaluationContext";
import {analyzeReturnPropagation} from "../scanner/analyzer/returnPropagationAnalyzer";
import {resolveFunctionFromCall} from "./callResolver";
import {ResolvedCallCache} from "../cache/resolvedCallCache";
import {ReturnPropagationCache} from "../cache/returnPropagationCache";
import {unwrapExpression, getPropertyName} from "../shared/utils";

export interface ResolveResult {
  readonly values: readonly string[];
  readonly dynamic: boolean;
}

function unique(values: readonly string[],): string[] {
  return [
    ...new Set(values),
  ];
}

function empty(): ResolveResult {
  return {
    values: [],
    dynamic: true,
  };
}

function concat(left: readonly string[], right: readonly string[],): string[] {
  const result: string[] = [];
  for (const l of left) {
    for (const r of right) {
      result.push(l + r);
    }
  }
  return unique(result);
}

// Walks a chain rooted at a parameter-bound identifier — e.g. `payload.nested`
// inside `payload.nested.event` — down to the object literal it refers to, so
// resolvePropertyAccess can pick the final property off a nested payload, not
// just a one-level-deep one.
function resolveBoundObjectNode(rawNode: ts.Expression, checker: ts.TypeChecker, context: EvaluationContext): ts.Expression | null {
  const node = unwrapExpression(rawNode);
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || !context.parameterBindings.has(symbol)) {
      return null;
    }
    // `has(symbol)` above already guarantees a Map entry exists, and every
    // caller only ever `.set()`s parameterBindings to a real ts.Expression
    // (never `undefined`) - so `.get(symbol)` can't actually miss here; the
    // `?? null` is defensive typing, not a reachable second outcome.
    /* v8 ignore next */
    return context.parameterBindings.get(symbol) ?? null;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node) || ts.isElementAccessExpression(node)) {
    const propertyName = getPropertyName(node);
    if (!propertyName) {
      return null;
    }
    const base = resolveBoundObjectNode(node.expression, checker, context);
    if (!base || !ts.isObjectLiteralExpression(base)) {
      return null;
    }
    for (const property of base.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        continue;
      }
      const objectPropertyName = ts.isIdentifier(property.name) ? property.name.text : property.name.getText();
      if (objectPropertyName !== propertyName) {
        continue;
      }
      return ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
    }
    return null;
  }
  return null;
}

// Walks up from a `this` reference to the class it's lexically inside of, so
// `this.EVENT_NAME` can be resolved against that class's own property
// declarations - the same idea as resolving a plain identifier against its
// variable declaration, just rooted at the enclosing class instead of a
// module-scope symbol (`this` itself has no symbol/declaration of its own to
// look up via the checker).
function findEnclosingClass(node: ts.Node): ts.ClassLikeDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function isFunctionLikeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

// Collects every `return <expr>;` belonging directly to `getter` - i.e. not
// one that belongs to a function/method/accessor nested inside its body.
// A getter with conditional returns is legitimately multi-valued (which
// branch runs depends on runtime state), so the caller unions more than one
// of these the same way it already does for a reassigned `let`.
function collectReturnExpressions(getter: ts.GetAccessorDeclaration): readonly ts.Expression[] {
  const expressions: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (node !== getter && isFunctionLikeBoundary(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      expressions.push(node.expression);
    }
    ts.forEachChild(node, visit);
  }
  if (getter.body) {
    visit(getter.body);
  }
  return expressions;
}

function getMemberName(member: ts.PropertyDeclaration | ts.GetAccessorDeclaration): string | null {
  return ts.isIdentifier(member.name) ? member.name.text : ts.isStringLiteral(member.name) ? member.name.text : null;
}

function resolvePropertyAccess(node: ts.PropertyAccessExpression | ts.PropertyAccessChain | ts.ElementAccessExpression, checker: ts.TypeChecker, context: EvaluationContext, visited: Set<ts.Node>, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache | undefined, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache): ResolveResult {
  const propertyName = getPropertyName(node);
  if (!propertyName) {
    return empty();
  }
  // payload.event
  // payload["event"]
  // payload.nested.event
  const targetExpression = ts.isElementAccessExpression(node) ? node.expression : node.expression;
  {
    const bound = resolveBoundObjectNode(targetExpression, checker, context);
    if (bound && ts.isObjectLiteralExpression(bound)) {
      for (const property of bound.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          continue;
        }
        const objectPropertyName = ts.isIdentifier(property.name) ? property.name.text : property.name.getText();
        if (objectPropertyName !== propertyName) {
          continue;
        }
        const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
        return resolveNodeValue(initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      }
    }
  }
  // this.EVENT_NAME
  // class Foo { EVENT_NAME = "checkout"; bar() { track(this.EVENT_NAME); } }
  //
  // this.computedEventName (getter)
  // class Foo { get computedEventName() { return "checkout"; } }
  if (targetExpression.kind === ts.SyntaxKind.ThisKeyword) {
    const enclosingClass = findEnclosingClass(node);
    if (enclosingClass) {
      for (const member of enclosingClass.members) {
        if (ts.isPropertyDeclaration(member) && member.initializer && getMemberName(member) === propertyName) {
          return resolveNodeValue(member.initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        }
        if (ts.isGetAccessorDeclaration(member) && getMemberName(member) === propertyName) {
          const returnExpressions = collectReturnExpressions(member);
          if (returnExpressions.length === 0) {
            return empty();
          }
          if (returnExpressions.length === 1) {
            return resolveNodeValue(returnExpressions[0], checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
          }
          const values: string[] = [];
          for (const expression of returnExpressions) {
            const resolved = resolveNodeValue(expression, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
            values.push(...resolved.values);
          }
          return {
            values: unique(values),
            dynamic: true,
          };
        }
      }
    }
    return empty();
  }
  if (ts.isIdentifier(targetExpression)) {
    let symbol = checker.getSymbolAtLocation(targetExpression);
    if (symbol) {
      symbol = resolveExportedSymbol(symbol, checker, exportCache) ?? symbol;
    }
    // enum EVENTS {
    //   LOGIN = "login"
    // }
    if (symbol) {
      // symbol comes from checker.getSymbolAtLocation (never a hand-built
      // duck-typed object here), and real ts.Symbol.getDeclarations() always
      // returns an array (possibly empty) rather than undefined - the `?? []`
      // is defensive against the wider `Declaration[] | undefined` type, not
      // a reachable second outcome for a real symbol.
      /* v8 ignore next */
      const declarations = symbol.getDeclarations() ?? [];
      for (const declaration of declarations) {
        if (!ts.isEnumDeclaration(declaration)) {
          continue;
        }
        for (const member of declaration.members) {
          // An EnumMember's `name` can only be an Identifier or a
          // StringLiteral per the TS grammar - the `: null` fallback has no
          // third case to reach.
          /* v8 ignore next */
          const memberName = ts.isIdentifier(member.name) ? member.name.text : ts.isStringLiteral(member.name) ? member.name.text : null;
          if (memberName !== propertyName || !member.initializer) {
            continue;
          }
          return resolveNodeValue(member.initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        }
      }
    }
    // const EVENTS = {
    //   LOGIN: "login"
    // }
    if (symbol) {
      // See the identical `?? []` above the enum-member loop: a real
      // ts.Symbol here always has a declarations array.
      /* v8 ignore next */
      const declarations = symbol.getDeclarations() ?? [];
      for (const declaration of declarations) {
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
          continue;
        }
        for (const property of declaration.initializer.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            continue;
          }
          const objectPropertyName = ts.isIdentifier(property.name) ? property.name.text : property.name.getText();
          if (objectPropertyName !== propertyName) {
            continue;
          }
          const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
          return resolveNodeValue(initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        }
      }
    }
  }

  return empty();
}

function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

// `ts.isAssignmentOperator` exists on the compiled module at runtime but
// isn't part of the public .d.ts (an internal-only export), so the operator
// set is spelled out here instead of depending on an undocumented API.
const ASSIGNMENT_OPERATOR_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

interface ReassignmentInfo {
  // Resolvable RHS expressions from plain `x = <expr>` assignments.
  readonly values: readonly ts.Expression[];
  // True when a compound assignment (`x += y`, `x ||= y`, `x **= y`, ...) was
  // found. Its resulting value depends on `x`'s own prior value, which this
  // flow-insensitive resolver has no sound way to fold, so it never becomes a
  // candidate literal - but its mere presence still means the binding can't
  // be trusted as a single confident value either.
  readonly hasUnresolvedReassignment: boolean;
}

// A `let`/`var` binding can be reassigned after its declaration - resolving
// only the initializer would confidently report a value that a later
// assignment (still just as static - a literal, another variable, a
// template, etc.) overwrites before any sink ever sees it. This walks the
// declaring file(s) for every assignment to `symbol` so the caller can treat
// the binding as multi-valued (or at least uncertain) instead of silently
// trusting the first value it was ever given.
function collectReassignments(symbol: ts.Symbol, checker: ts.TypeChecker): ReassignmentInfo {
  const values: ts.Expression[] = [];
  let hasUnresolvedReassignment = false;
  // See the identical `?? []` elsewhere in this file: a real ts.Symbol here
  // always has a declarations array.
  /* v8 ignore next */
  const sourceFiles = new Set((symbol.getDeclarations() ?? []).map(declaration => declaration.getSourceFile()));
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        ASSIGNMENT_OPERATOR_KINDS.has(node.operatorToken.kind) &&
        ts.isIdentifier(node.left) &&
        checker.getSymbolAtLocation(node.left) === symbol
      ) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          values.push(node.right);
        } else {
          hasUnresolvedReassignment = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { values, hasUnresolvedReassignment };
}

function resolveIdentifier(node: ts.Identifier, checker: ts.TypeChecker, context: EvaluationContext, visited: Set<ts.Node>, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache | undefined, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache,): ResolveResult {
  const boundSymbol = checker.getSymbolAtLocation(node);
  if (boundSymbol && context.parameterBindings.has(boundSymbol)) {
    const bound = context.parameterBindings.get(boundSymbol);
    // `has(boundSymbol)` above already guarantees a Map entry, and every
    // caller only ever `.set()`s parameterBindings to a real ts.Expression
    // (never `undefined`) - so this is always truthy when reached.
    /* v8 ignore else */
    if (bound) {
      return resolveNodeValue(bound, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
  }
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return empty();
  }

  symbol = resolveExportedSymbol(symbol, checker, exportCache) ?? symbol;
  const cached = evaluationCache.get(symbol);
  if (cached) {
    return cached;
  }
  const resolving = empty();
  evaluationCache.set(symbol, resolving);
  // See the identical `?? []` above in resolvePropertyAccess: a real
  // ts.Symbol here always has a declarations array.
  /* v8 ignore next */
  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const reassignment = isConstDeclaration(declaration) ? null : collectReassignments(symbol, checker);
      if (!reassignment || (reassignment.values.length === 0 && !reassignment.hasUnresolvedReassignment)) {
        const resolved = resolveNodeValue(declaration.initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        evaluationCache.set(symbol, resolved);
        return resolved;
      }
      const values: string[] = [];
      for (const expression of [declaration.initializer, ...reassignment.values]) {
        const resolvedValue = resolveNodeValue(expression, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        values.push(...resolvedValue.values);
      }
      const resolved: ResolveResult = {
        values: unique(values),
        dynamic: true,
      };
      evaluationCache.set(symbol, resolved);
      return resolved;
    }

    if (ts.isEnumMember(declaration) && declaration.initializer) {
      const resolved = resolveNodeValue(declaration.initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      evaluationCache.set(symbol, resolved);
      return resolved;
    }
  }

  return resolving;
}

function resolveCallExpression(node: ts.CallExpression, checker: ts.TypeChecker, context: EvaluationContext, visited: Set<ts.Node>, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache | undefined, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache): ResolveResult {
  const resolved = resolveFunctionFromCall(node.expression, checker, resolvedCallCache ?? new ResolvedCallCache(), exportCache);
  if (!resolved) {
    return empty();
  }
  let semantic = returnPropagationCache.get(resolved);
  if (semantic === undefined) {
    semantic = analyzeReturnPropagation(resolved);
    returnPropagationCache.set(resolved, semantic);
  }
  if (!semantic) {
    return empty();
  }
  const values: string[] = [];
  for (const propagation of semantic.propagations) {
    // Call site can omit the argument and rely on the parameter's own default
    // value (`function build(name = "x") {}` called as `build()`) - that
    // default is a real static literal, so fall back to it instead of
    // dropping the call site.
    const argument = node.arguments[propagation.parameterIndex] ?? propagation.parameter.initializer;
    if (!argument) {
      continue;
    }
    const nextContext = {
      parameterBindings: new Map(context.parameterBindings),
    };
    // returnPropagationAnalyzer's resolveParameter only ever returns a
    // parameter whose `.name` is a plain ts.Identifier (destructured/
    // computed parameter names are filtered out there), so a real program's
    // checker always resolves a symbol for it here.
    const parameterSymbol = checker.getSymbolAtLocation(propagation.parameter.name);
    /* v8 ignore next 2 */
    if (parameterSymbol) {
      nextContext.parameterBindings.set(parameterSymbol, argument);
    }

    const resolvedValue = resolveNodeValue(propagation.returnExpression, checker, nextContext, new Set(visited), evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    values.push(...resolvedValue.values,);
  }
  return {
    values: unique(values),
    dynamic: true,
  };
}

export function resolveNodeValue(node: ts.Node, checker: ts.TypeChecker, context: EvaluationContext, visited: Set<ts.Node>, evaluationCache: EvaluationCache, resolvedCallCache: ResolvedCallCache | undefined, returnPropagationCache: ReturnPropagationCache, exportCache: ResolvedExportCache): ResolveResult {
  if (visited.has(node)) {
    return empty();
  }
  visited.add(node);
  try {
    if (ts.isStringLiteral(node)) {
      return {
        values: [node.text],
        dynamic: false,
      };
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return {
        values: [node.text],
        dynamic: false,
      };
    }
    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans) {
        const resolved = resolveNodeValue(span.expression, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        values = concat(values, resolved.values.map(value => value + span.literal.text));
      }
      return {
        values: unique(values),
        dynamic: true,
      };
    }
    if (ts.isConditionalExpression(node)) {
      const whenTrue = resolveNodeValue(node.whenTrue, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      const whenFalse = resolveNodeValue(node.whenFalse, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      return {
        values: unique([...whenTrue.values, ...whenFalse.values]),
        dynamic: true,
      };
    }

    if (ts.isArrayLiteralExpression(node)) {
      const values: string[] = [];
      for (const element of node.elements) {
        const resolved = resolveNodeValue(element, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        values.push(...resolved.values);
      }
      return {
        values: unique(values),
        dynamic: true,
      };
    }

    if (ts.isObjectLiteralExpression(node)) {
      const values: string[] = [];
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          continue;
        }
        const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
        const resolved = resolveNodeValue(initializer, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
        values.push(...resolved.values);
      }
      return {
        values: unique(values),
        dynamic: true,
      };
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return resolveNodeValue(node.expression, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node) || ts.isElementAccessExpression(node)) {
      return resolvePropertyAccess(node, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
    if (ts.isIdentifier(node)) {
      return resolveIdentifier(node, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveNodeValue(node.left, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      const right = resolveNodeValue(node.right, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
      return {
        values: concat(left.values, right.values),
        dynamic: true,
      };
    }
    if (ts.isCallExpression(node)) {
      return resolveCallExpression(node, checker, context, visited, evaluationCache, resolvedCallCache, returnPropagationCache, exportCache);
    }
    return empty();
  } finally {
    visited.delete(node);
  }
}
