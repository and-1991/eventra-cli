import ts from "typescript";

import {ResolvedExportCache} from "../cache/resolvedExportCache";

function isConcreteDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node)
    || ts.isVariableDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isEnumDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isPropertyDeclaration(node)
  );
}

/**
 * `declare const x: typeof import("./module")["name"]` (or the dotted form,
 * `typeof import("./module").name`) is how Nuxt/unplugin-auto-import
 * generate global ambient bindings for auto-imported exports. A `const`
 * with no initializer is only legal in an ambient context, so this shape is
 * unambiguous. Without unwrapping it, this ambient variable is its own
 * distinct symbol — the wrapper/export registered under the *real*
 * declaration's symbol would never match a call site that resolves to the
 * ambient one instead.
 */
function resolveAmbientAutoImportSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol | null {
  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length !== 1) {
    return null;
  }
  const [declaration] = declarations;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer || !declaration.type) {
    return null;
  }

  let nameNode: ts.Node | undefined;
  const type = declaration.type;
  if (ts.isImportTypeNode(type) && type.qualifier && ts.isIdentifier(type.qualifier)) {
    nameNode = type.qualifier;
  } else if (
    ts.isIndexedAccessTypeNode(type)
    && ts.isImportTypeNode(type.objectType)
    && ts.isLiteralTypeNode(type.indexType)
    && ts.isStringLiteral(type.indexType.literal)
  ) {
    nameNode = type.indexType.literal;
  }
  if (!nameNode) {
    return null;
  }

  const resolved = checker.getSymbolAtLocation(nameNode);
  return resolved && resolved !== symbol ? resolved : null;
}

export function resolveExportedSymbol(symbol: ts.Symbol, checker: ts.TypeChecker, cache: ResolvedExportCache, visited?: Set<ts.Symbol>): ts.Symbol | null {
  if (typeof symbol.getDeclarations !== "function") {
    return null;
  }
  const seen = visited ?? new Set<ts.Symbol>();
  const cached = cache.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  // cycle guard
  if (seen.has(symbol)) {
    cache.set(symbol, null);
    return null;
  }
  seen.add(symbol);
  // alias unwrap
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol,);
    const resolved = resolveExportedSymbol(aliased, checker, cache, seen);
    cache.set(symbol, resolved);
    return resolved;
  }
  // export unwrap
  const exportSymbol = checker.getExportSymbolOfSymbol(symbol);
  if (exportSymbol && exportSymbol !== symbol) {
    const resolved = resolveExportedSymbol(exportSymbol, checker, cache, seen);
    cache.set(symbol, resolved);
    return resolved;
  }
  // ambient auto-import unwrap (Nuxt/unplugin-auto-import style globals)
  const ambientTarget = resolveAmbientAutoImportSymbol(symbol, checker);
  if (ambientTarget) {
    const resolved = resolveExportedSymbol(ambientTarget, checker, cache, seen);
    cache.set(symbol, resolved);
    return resolved;
  }
  // declaration existence
  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (isConcreteDeclaration(declaration)) {
      cache.set(symbol, symbol);
      return symbol;
    }
  }
  // final validation
  const valid = declarations.some(isConcreteDeclaration);
  if (valid) {
    cache.set(symbol, symbol);
    return symbol;
  }
  cache.set(symbol, null);
  return null;
}
