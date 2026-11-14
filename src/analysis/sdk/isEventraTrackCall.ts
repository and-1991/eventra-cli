import * as fs from "fs";
import * as path from "path";
import ts from "typescript";

import { EVENTRA_SDK_PACKAGE, isEventraSdkModuleSpecifier } from "./eventraSdk";
import { declaredTypeOfIdentifier } from "../shared/declaredType";

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

const sdkPackageByDir = new Map<string, boolean>();

/**
 * Whether `dir` lies inside the installed SDK package: the nearest `package.json` above it that has a name is the
 * SDK's. A `node_modules/@eventra_dev/eventra-sdk` folder and a workspace link to it (the compiler follows the link
 * to the real folder, whatever its path) both count; a folder of the user's that happens to be called
 * "eventra-sdk" does not. A `package.json` with no name (a `dist/cjs` folder's `{"type": "commonjs"}`) or one that
 * cannot be read is passed over.
 */
function isInSdkPackage(dir: string): boolean {
  const known = sdkPackageByDir.get(dir);
  if (known !== undefined) return known;
  let result = false;
  let name: unknown;
  try {
    name = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown } | null)?.name;
  } catch {
    name = undefined;
  }
  if (typeof name === "string") {
    result = name === EVENTRA_SDK_PACKAGE;
  } else {
    const parent = path.dirname(dir);
    result = parent !== dir && isInSdkPackage(parent);
  }
  sdkPackageByDir.set(dir, result);
  return result;
}

/**
 * The SDK's own `Eventra` class: declared inside `declare module "@eventra_dev/eventra-sdk"` (the CLI's own
 * stand-in for the SDK's types, which the compiler prefers to an installed copy), or in a declaration file of the
 * installed package. A class of the user's that is merely called `Eventra` is not the SDK, wherever it lives.
 */
function isEventraClassDeclaration(decl: ts.Declaration): boolean {
  if (!ts.isClassDeclaration(decl) || decl.name?.text !== "Eventra") {
    return false;
  }
  const ambient = ts.findAncestor(decl.parent, ts.isModuleDeclaration);
  if (ambient) {
    return ts.isStringLiteral(ambient.name) && isEventraSdkModuleSpecifier(ambient.name.text);
  }
  const file = decl.getSourceFile();
  return file.isDeclarationFile && isInSdkPackage(path.dirname(file.fileName));
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

/** `require("@eventra_dev/eventra-sdk")`, also awaited or in parentheses: the CommonJS way to load the SDK. */
function isRequireOfSdk(expression: ts.Expression | undefined): boolean {
  let expr = expression;
  while (expr && (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr) || ts.isNonNullExpression(expr) || ts.isAsExpression(expr))) {
    expr = expr.expression;
  }
  return (
    expr !== undefined &&
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "require" &&
    expr.arguments.length === 1 &&
    ts.isStringLiteralLike(expr.arguments[0]) &&
    isEventraSdkModuleSpecifier(expr.arguments[0].text)
  );
}

/**
 * The binding holds the SDK's class, or the whole module, because it was taken from a `require` of the
 * SDK: `const { Eventra } = require(sdk)`, `const Eventra = require(sdk).Eventra`, `const sdk = require(sdk)`.
 * `wholeModule` is the last form: the binding is the module, and the class is a property of it.
 */
function isRequiredFromSdk(symbol: ts.Symbol, wholeModule: boolean): boolean {
  // a symbol that came from a binding always has declarations
  return symbol.getDeclarations()!.some((decl) => {
    if (ts.isBindingElement(decl)) {
      const owner = ts.findAncestor(decl, ts.isVariableDeclaration);
      return !wholeModule && decl.name !== undefined && (decl.propertyName ?? decl.name).getText() === "Eventra" && isRequireOfSdk(owner?.initializer);
    }
    // `import sdk = require("@eventra_dev/eventra-sdk")`
    if (ts.isImportEqualsDeclaration(decl)) {
      const reference = decl.moduleReference;
      return (
        wholeModule &&
        ts.isExternalModuleReference(reference) &&
        ts.isStringLiteralLike(reference.expression) &&
        isEventraSdkModuleSpecifier(reference.expression.text)
      );
    }
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    if (wholeModule) return isRequireOfSdk(decl.initializer);
    const init = decl.initializer;
    return ts.isPropertyAccessExpression(init) && init.name.text === "Eventra" && isRequireOfSdk(init.expression);
  });
}

function isEventraNewExpression(node: ts.NewExpression, checker: ts.TypeChecker): boolean {
  const expr = node.expression;
  // `new sdk.Eventra(...)` / `new (require("...")).Eventra(...)`
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "Eventra") {
    const target = ts.isParenthesizedExpression(expr.expression) ? expr.expression.expression : expr.expression;
    if (isRequireOfSdk(target)) return true;
    const owner = ts.isIdentifier(target) ? checker.getSymbolAtLocation(target) : undefined;
    if (owner && isRequiredFromSdk(owner, true)) return true;
  }
  if (!ts.isIdentifier(expr)) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(expr);
  if (symbol && (isEventraSymbol(symbol, checker) || isRequiredFromSdk(symbol, false))) {
    return true;
  }
  // `const { Eventra } = await import("@eventra_dev/eventra-sdk")`: the binding is not an import, but
  // the instance it builds is still typed as the SDK's class
  return typeLooksLikeEventra(checker.getTypeAtLocation(node), checker);
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

  if (type.isUnionOrIntersection()) {
    return type.types.some((t) => typeLooksLikeEventra(t, checker, depth + 1));
  }

  return false;
}

const MAX_RECEIVER_HOPS = 6;

/** `return expr` statements of a function body, not looking into functions nested in it. */
function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!fn.body) {
    return [];
  }
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      found.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

function functionOf(decl: ts.Declaration): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) {
    return decl;
  }
  if (ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
    return decl.initializer;
  }
  return undefined;
}

// Every `identifier = value` in a file, by the symbol assigned to. Built once per file and checker: walking the whole
// declaring file again for each `x.track()` made a file with thousands of such calls quadratic (20k calls took minutes).
// Keyed by checker, since a new program (watch mode) has new symbols.
const assignmentsCache = new WeakMap<ts.TypeChecker, WeakMap<ts.SourceFile, Map<ts.Symbol, ts.Expression[]>>>();

function assignmentsIn(file: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Symbol, ts.Expression[]> {
  let byFile = assignmentsCache.get(checker);
  if (!byFile) {
    byFile = new WeakMap();
    assignmentsCache.set(checker, byFile);
  }
  let found = byFile.get(file);
  if (found) return found;
  const assignments = new Map<ts.Symbol, ts.Expression[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) {
        const list = assignments.get(symbol);
        if (list) list.push(node.right);
        else assignments.set(symbol, [node.right]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  found = assignments;
  byFile.set(file, found);
  return found;
}

/** `t = new Eventra(...)` anywhere in the file of a variable's declaration: a lazily filled `let t: any`. */
function assignedValues(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Expression[] {
  const values: ts.Expression[] = [];
  const files = new Set((symbol.getDeclarations() ?? []).map((decl) => decl.getSourceFile()));
  for (const file of files) {
    values.push(...(assignmentsIn(file, checker).get(symbol) ?? []));
  }
  return values;
}

/**
 * True when a bare identifier's declared type has nothing of the SDK in it, so the type at this spot cannot be the
 * SDK either (see declaredTypeOfIdentifier: this skips TypeScript's per-spot flow analysis).
 */
function declaredTypeRulesOutEventra(receiver: ts.Expression, checker: ts.TypeChecker): boolean {
  const declared = declaredTypeOfIdentifier(receiver, checker);
  return declared !== undefined && !typeLooksLikeEventra(declared, checker);
}

function isEventraReceiverExpression(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
  hops = 0,
): boolean {
  if (hops > MAX_RECEIVER_HOPS) {
    return false;
  }
  // `(await getTracker()).track(...)`, `(tracker as Eventra).track(...)`, `tracker!.track(...)`
  if (ts.isParenthesizedExpression(receiver) || ts.isAwaitExpression(receiver) || ts.isNonNullExpression(receiver) || ts.isAsExpression(receiver)) {
    return isEventraReceiverExpression(receiver.expression, checker, hops + 1);
  }

  if (ts.isNewExpression(receiver)) {
    return isEventraNewExpression(receiver, checker);
  }

  if (ts.isCallExpression(receiver) && ts.isNewExpression(receiver.expression)) {
    return isEventraNewExpression(receiver.expression, checker);
  }

  if (!declaredTypeRulesOutEventra(receiver, checker)) {
    const type = checker.getTypeAtLocation(receiver);
    if (typeLooksLikeEventra(type, checker)) {
      return true;
    }
  }

  // `getTracker().track(...)` where the getter's type is lost (`any`) but what it returns is a tracker
  if (ts.isCallExpression(receiver)) {
    const callee = ts.isIdentifier(receiver.expression) || ts.isPropertyAccessExpression(receiver.expression)
      ? checker.getSymbolAtLocation(ts.isIdentifier(receiver.expression) ? receiver.expression : receiver.expression.name)
      : undefined;
    for (const decl of callee?.getDeclarations() ?? []) {
      const fn = functionOf(decl);
      if (fn && returnedExpressions(fn).some((returned) => isEventraReceiverExpression(returned, checker, hops + 1))) {
        return true;
      }
    }
  }

  if (ts.isIdentifier(receiver)) {
    const symbol = checker.getSymbolAtLocation(receiver);
    if (!symbol) {
      return false;
    }
    // See the identical `?? []` above isEventraSymbol's declaration loop: a
    // real ts.Symbol here always has a declarations array.
    /* v8 ignore next */
    if (assignedValues(symbol, checker).some((value) => isEventraReceiverExpression(value, checker, hops + 1))) {
      return true;
    }
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
    return isEventraReceiverExpression(receiver.expression, checker, hops + 1);
  }

  return false;
}

/** `instance.track.call(thisArg, "x")`: the name is the second argument, after the `this` the call passes on. */
function isTrackDotCall(expr: ts.Expression): expr is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(expr) && expr.name.text === "call" && isTrackCallee(expr.expression);
}

/** Which argument of an SDK `track` call holds the event name: 1 for `track.call(this, name)`, else 0. */
export function trackNameArgument(call: ts.CallExpression): number {
  return isTrackDotCall(call.expression) ? 1 : 0;
}

/** Only `instance.track(...)` (or `instance.track.call(...)`) where instance is Eventra from @eventra_dev/eventra-sdk. */
export function isEventraSdkTrackCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  // `tracker.track.call(tracker, "x")` is a call of `track` through `.call`
  const expr = isTrackDotCall(call.expression) ? call.expression.expression : call.expression;
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
