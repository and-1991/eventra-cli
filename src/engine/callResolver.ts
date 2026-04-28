import ts from "typescript";

export function resolveFunctionFromCall(
  expr: ts.Expression,
  checker: ts.TypeChecker
): ts.FunctionLikeDeclaration | null {

  const type = checker.getTypeAtLocation(expr);
  const signatures = type.getCallSignatures();

  for (const sig of signatures) {
    const decl = sig.getDeclaration();

    if (
      decl &&
      (ts.isFunctionDeclaration(decl) ||
        ts.isMethodDeclaration(decl) ||
        ts.isFunctionExpression(decl) ||
        ts.isArrowFunction(decl))
    ) {
      return decl;
    }
  }

  return null;
}
