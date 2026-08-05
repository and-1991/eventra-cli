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
  // cycle guard - defends against a cycle re-entering this function via the
  // alias/export/ambient recursive calls below. In practice, a genuinely
  // circular alias chain (e.g. two barrel files re-exporting each other's
  // binding) is collapsed by the TypeScript checker itself: getAliasedSymbol
  // returns its own synthetic "unknown" symbol after a single hop rather than
  // looping, and getExportSymbolOfSymbol/the ambient-auto-import unwrap were
  // not observed (across many realistic export shapes: named/default/star/
  // namespace-as/CJS `export =`/ambient-module/UMD re-exports) to ever
  // redirect to an already-visited symbol either. We could not construct a
  // realistic source file that re-enters with the same symbol still `seen`.
  /* v8 ignore next 4 */
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
  // export unwrap - TypeScript's binder can in principle give a declaration a
  // distinct "local" symbol and "export" symbol (see `declareModuleMember`'s
  // `local.exportSymbol` link), but this was not observed via
  // checker.getSymbolAtLocation for any realistic export shape we tried
  // (named/default/star/namespace-as/CJS `export =`/ambient-module/UMD
  // exports, from both the declaring file and importing files) - the split
  // only seems to materialize for binder-internal container shapes we could
  // not reach from ordinary source text.
  const exportSymbol = checker.getExportSymbolOfSymbol(symbol);
  /* v8 ignore next 4 */
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
  // final validation - `.some(isConcreteDeclaration)` re-checks the exact same
  // predicate over the exact same `declarations` array the for-loop above just
  // iterated without finding a match; if the loop didn't return, `.some` of
  // the identical predicate over the identical array is guaranteed false too.
  const valid = declarations.some(isConcreteDeclaration);
  /* v8 ignore next 3 */
  if (valid) {
    cache.set(symbol, symbol);
    return symbol;
  }
  cache.set(symbol, null);
  return null;
}
