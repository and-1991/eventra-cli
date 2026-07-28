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

function isEventraClassDeclaration(decl: ts.Declaration): boolean {
  if (!ts.isClassDeclaration(decl) || decl.name?.text !== "Eventra") {
    return false;
  }
  const file = decl.getSourceFile().fileName.replace(/\\/g, "/");
  return file.includes("eventra-sdk") || file.includes("@eventra_dev");
}

function isEventraSymbol(symbol: ts.Symbol, checker: ts.TypeChecker, depth = 0): boolean {
  if (depth > 10) {
    return false;
  }

  if (symbol.flags & ts.SymbolFlags.Alias) {
    return isEventraSymbol(checker.getAliasedSymbol(symbol), checker, depth + 1);
  }

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

  const receiver =
    ts.isPropertyAccessExpression(expr) ||
    ts.isPropertyAccessChain(expr) ||
    ts.isElementAccessExpression(expr)
      ? expr.expression
      : undefined;

  if (!receiver) {
    return false;
  }

  return isEventraReceiverExpression(receiver, checker);
}
