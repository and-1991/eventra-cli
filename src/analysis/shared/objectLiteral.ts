import ts from "typescript";

import {getValueSymbol} from "../symbols/symbolUtils";
import {unwrapExpression} from "./utils";

const MAX_SPREAD_HOPS = 4;

/**
 * The object literal an expression stands for: itself, or the initializer of a `const` it names
 * (`const rest = { name: "x" }; <A {...rest} />`), through a few renames. Null for anything the
 * analysis cannot see into (a parameter, a call, a mutable `let`).
 */
export function objectLiteralOf(expression: ts.Expression, checker: ts.TypeChecker, hops = 0): ts.ObjectLiteralExpression | null {
  const current = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(current)) {
    return current;
  }
  if (!ts.isIdentifier(current) || hops >= MAX_SPREAD_HOPS) {
    return null;
  }
  // an identifier the checker knows always has a symbol with declarations; the `?? []` is only the type's other case
  /* v8 ignore next */
  for (const declaration of getValueSymbol(current, checker)?.getDeclarations() ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0) {
      return objectLiteralOf(declaration.initializer, checker, hops + 1);
    }
  }
  return null;
}

const propertyNameOf = (property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): string =>
  ts.isIdentifier(property.name) ? property.name.text : ts.isStringLiteral(property.name) ? property.name.text : property.name.getText();

/**
 * The value `segment` has in an object literal. Later properties win, as they do at runtime, and a
 * spread is looked into when it is an object the analysis can see. A spread of anything else may hold
 * the property too, so nothing after it can be trusted: the answer is unknown (null), not a guess.
 */
export function objectPropertyValue(literal: ts.ObjectLiteralExpression, segment: string, checker: ts.TypeChecker, hops = 0): ts.Expression | null {
  for (let index = literal.properties.length - 1; index >= 0; index--) {
    const property = literal.properties[index];
    if (ts.isSpreadAssignment(property)) {
      const spread = hops < MAX_SPREAD_HOPS ? objectLiteralOf(property.expression, checker) : null;
      if (!spread) {
        return null;
      }
      const found = objectPropertyValue(spread, segment, checker, hops + 1);
      if (found) {
        return found;
      }
      continue;
    }
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      continue;
    }
    if (propertyNameOf(property) === segment) {
      return ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
    }
  }
  return null;
}
