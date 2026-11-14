import ts from "typescript";

// Types that narrowing can change into something else: `x instanceof C` on any/unknown, an auto-typed `let x;`,
// a generic.
const OPEN_TYPE = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Instantiable;

/**
 * The declared type of a bare identifier (a variable, a parameter, an import of one), or undefined when it is not
 * known or narrowing at some spot could make it something else (any, unknown, a generic, or such a member of a union).
 *
 * Asking TypeScript for the type or a member at a spot runs its flow analysis back through every statement before
 * that spot. Done for each of thousands of `analytics.track()` calls in one file, that is quadratic (20k calls took
 * minutes). The declared type costs nothing per call, and narrowing only ever removes from it.
 */
export function declaredTypeOfIdentifier(expression: ts.Expression, checker: ts.TypeChecker): ts.Type | undefined {
  if (!ts.isIdentifier(expression)) return undefined;
  let symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (!(symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property))) return undefined;
  const declared = checker.getTypeOfSymbol(symbol);
  if (declared.flags & OPEN_TYPE) return undefined;
  if (declared.isUnion() && declared.types.some((member) => member.flags & OPEN_TYPE)) return undefined;
  return declared;
}

/**
 * The member `name` of `receiver.name`, read from the receiver's declared type when that is a single object type:
 * narrowing cannot change which member that is. Undefined when this shortcut does not apply (the caller then asks
 * TypeScript at the spot as before).
 */
export function memberOfDeclaredType(receiver: ts.Expression, name: string, checker: ts.TypeChecker): ts.Symbol | undefined {
  const declared = declaredTypeOfIdentifier(receiver, checker);
  if (!declared || declared.isUnionOrIntersection() || !(declared.flags & ts.TypeFlags.Object)) return undefined;
  return checker.getPropertyOfType(declared, name);
}
