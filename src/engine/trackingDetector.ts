import ts from "typescript";

export function isTrackingCall(
  node: ts.CallExpression
): boolean {
  const expr = node.expression;

  if (ts.isIdentifier(expr)) {
    return expr.text === "track";
  }

  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text === "track";
  }

  return false;
}
