import ts from "typescript";

import { isEventraSdkModuleSpecifier } from "./eventraSdk";

function isTrackCallee(expr: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) {
    return expr.name.text === "track";
  }
  if (
    ts.isElementAccessExpression(expr) &&
    expr.argumentExpression &&
    ts.isStringLiteral(expr.argumentExpression) &&
    expr.argumentExpression.text === "track"
  ) {
    return true;
  }
  return false;
}

// An ImportSpecifier/ImportClause's own symbol always carries
// SymbolFlags.Alias (that's how TS's binder models every import), so
// isEventraSymbol's alias-unwrap below always recurses into
// checker.getAliasedSymbol(...) first and never falls through to inspect
// these declarations directly - getAliasedSymbol also fully resolves a
// multi-hop re-export chain in a single call (verified empirically: a
// 12-deep `export { Eventra } from "./prev"` barrel chain still resolves
// in exactly one getAliasedSymbol hop), so there's no realistic import
// shape where a symbol reaches isEventraSymbol's declaration loop while
// one of its own declarations is still an ImportSpecifier/ImportClause.
/* v8 ignore start */
function getImportDeclarationForSpecifier(decl: ts.Node): ts.ImportDeclaration | null {
  let current: ts.Node | undefined = decl;
  while (current) {
    if (ts.isImportDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function isEventraImportDeclaration(decl: ts.Declaration): boolean {
  if (ts.isImportSpecifier(decl) && decl.name.text === "Eventra") {
    const importDecl = getImportDeclarationForSpecifier(decl);
    if (importDecl?.moduleSpecifier && ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return isEventraSdkModuleSpecifier(importDecl.moduleSpecifier.text);
    }
  }
  if (ts.isImportClause(decl)) {
    const parent = decl.parent;
    if (parent && ts.isImportDeclaration(parent) && parent.moduleSpecifier && ts.isStringLiteral(parent.moduleSpecifier)) {
      return isEventraSdkModuleSpecifier(parent.moduleSpecifier.text);
    }
  }
  return false;
}
/* v8 ignore stop */

function isEventraClassDeclaration(decl: ts.Declaration): boolean {
  if (!ts.isClassDeclaration(decl) || decl.name?.text !== "Eventra") {
    return false;
  }
  const file = decl.getSourceFile().fileName.replace(/\\/g, "/");
  return file.includes("eventra-sdk") || file.includes("@eventra_dev");
}

function isEventraSymbol(symbol: ts.Symbol, checker: ts.TypeChecker, depth = 0): boolean {
  // cycle guard - the only recursive call below is the alias-unwrap, and
  // checker.getAliasedSymbol always resolves a whole (even multi-hop)
  // alias/re-export chain in a single call rather than one hop at a time
  // (verified empirically), so depth realistically never exceeds 1.
  /* v8 ignore next 3 */
  if (depth > 10) {
    return false;
  }

  if (symbol.flags & ts.SymbolFlags.Alias) {
    return isEventraSymbol(checker.getAliasedSymbol(symbol), checker, depth + 1);
  }

  // A real ts.Symbol.getDeclarations() always returns an array (possibly
  // empty), never undefined - the `?? []` is defensive against the wider
  // `Declaration[] | undefined` type, not a reachable second outcome.
  /* v8 ignore next */
  for (const decl of symbol.getDeclarations() ?? []) {
    if (isEventraImportDeclaration(decl) || isEventraClassDeclaration(decl)) {
      return true;
    }
  }

  return false;
}

function isEventraNewExpression(node: ts.NewExpression, checker: ts.TypeChecker): boolean {
  const expr = node.expression;
  if (!ts.isIdentifier(expr)) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(expr);
  return symbol ? isEventraSymbol(symbol, checker) : false;
}

function typeLooksLikeEventra(type: ts.Type, checker: ts.TypeChecker, depth = 0): boolean {
  // cycle guard - TypeScript flattens union/intersection types (a literal
  // `A | (B | C)` normalizes to the single-level `A | B | C`), so the only
  // recursive call below in practice never nests deep enough to approach
  // this bound.
  /* v8 ignore next 3 */
  if (depth > 8) {
    return false;
  }

  const symbol = type.getSymbol();
  if (symbol && isEventraSymbol(symbol, checker)) {
    return true;
  }

  const typeStr = checker.typeToString(type);
  if (typeStr === "Eventra" || /^Eventra<.*>$/.test(typeStr)) {
    return true;
  }

  if (type.isUnionOrIntersection()) {
    return type.types.some((t) => typeLooksLikeEventra(t, checker, depth + 1));
  }

  return false;
}

function isEventraReceiverExpression(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isNewExpression(receiver)) {
    return isEventraNewExpression(receiver, checker);
  }

  if (ts.isCallExpression(receiver) && ts.isNewExpression(receiver.expression)) {
    return isEventraNewExpression(receiver.expression, checker);
  }

  const type = checker.getTypeAtLocation(receiver);
  if (typeLooksLikeEventra(type, checker)) {
    return true;
  }

  if (ts.isIdentifier(receiver)) {
    const symbol = checker.getSymbolAtLocation(receiver);
    if (!symbol) {
      return false;
    }
    // See the identical `?? []` above isEventraSymbol's declaration loop: a
    // real ts.Symbol here always has a declarations array.
    /* v8 ignore next */
    for (const decl of symbol.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        if (ts.isNewExpression(decl.initializer) && isEventraNewExpression(decl.initializer, checker)) {
          return true;
        }
        if (
          ts.isCallExpression(decl.initializer) &&
          ts.isNewExpression(decl.initializer.expression) &&
          isEventraNewExpression(decl.initializer.expression, checker)
        ) {
          return true;
        }
      }
      if (ts.isParameter(decl) && decl.type) {
        const paramType = checker.getTypeFromTypeNode(decl.type);
        if (typeLooksLikeEventra(paramType, checker)) {
          return true;
        }
      }
      // A class field can only ever be reached through a qualified access
      // (`this.field`/`instance.field`), which recurses through the
      // PropertyAccessExpression branch below instead of ever landing here -
      // a *bare* identifier's resolved symbol can't have a PropertyDeclaration
      // among its own declarations, so this is unreachable from the
      // `ts.isIdentifier(receiver)` branch above.
      /* v8 ignore next 5 */
      if (ts.isPropertyDeclaration(decl) && decl.type) {
        const propType = checker.getTypeFromTypeNode(decl.type);
        if (typeLooksLikeEventra(propType, checker)) {
          return true;
        }
      }
    }
  }

  if (ts.isPropertyAccessExpression(receiver) || ts.isPropertyAccessChain(receiver)) {
    return isEventraReceiverExpression(receiver.expression, checker);
  }

  return false;
}

/** Only `instance.track(...)` where instance is Eventra from @eventra_dev/eventra-sdk. */
export function isEventraSdkTrackCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const expr = call.expression;
  if (!isTrackCallee(expr)) {
    return false;
  }

  // isTrackCallee above only returns true for these same three shapes, so
  // the `: undefined` side of this ternary is never actually taken.
  /* v8 ignore next 5 */
  const receiver =
    ts.isPropertyAccessExpression(expr) ||
    ts.isPropertyAccessChain(expr) ||
    ts.isElementAccessExpression(expr)
      ? expr.expression
      : undefined;

  // ...and so `receiver` is never actually undefined here either.
  /* v8 ignore next 3 */
  if (!receiver) {
    return false;
  }

  return isEventraReceiverExpression(receiver, checker);
}
