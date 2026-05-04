import ts from "typescript";

function isStringLike(type: ts.Type) {
  return (
    (type.flags & ts.TypeFlags.StringLike) !== 0 ||
    (type.flags & ts.TypeFlags.StringLiteral) !== 0
  );
}

function hasTrackLikeSignature(
  type: ts.Type,
  checker: ts.TypeChecker
): boolean {
  const sigs = type.getCallSignatures();

  for (const sig of sigs) {
    const params = sig.getParameters();
    if (!params.length) continue;

    const t = checker.getTypeOfSymbolAtLocation(
      params[0],
      params[0].valueDeclaration!
    );

    if (isStringLike(t)) {
      return true;
    }
  }

  return false;
}

function isEventraLikeType(
  type: ts.Type,
  checker: ts.TypeChecker
): boolean {
  const props = type.getProperties();

  for (const prop of props) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) continue;

    const t = checker.getTypeOfSymbolAtLocation(prop, decl);

    if (hasTrackLikeSignature(t, checker)) {
      return true;
    }
  }

  return false;
}

export function isTrackingCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker
): boolean {
  const expr = node.expression;

  // fn(...)
  if (ts.isIdentifier(expr)) {
    const type = checker.getTypeAtLocation(expr);
    if (hasTrackLikeSignature(type, checker)) {
      return true;
    }
  }

  // obj.method(...)
  if (ts.isPropertyAccessExpression(expr)) {
    const objType = checker.getTypeAtLocation(expr.expression);

    // объект похож на tracker
    if (isEventraLikeType(objType, checker)) {
      return true;
    }

    // fallback
    const methodType = checker.getTypeAtLocation(expr.name);

    if (hasTrackLikeSignature(methodType, checker)) {
      return true;
    }
  }

  // obj["track"](...)
  if (ts.isElementAccessExpression(expr)) {
    const objType = checker.getTypeAtLocation(expr.expression);

    if (isEventraLikeType(objType, checker)) {
      return true;
    }
  }

  return false;
}
