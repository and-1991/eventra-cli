import {
  Node,
  SyntaxKind
} from "ts-morph";

import { ExtractedEvent } from "../types";

export function extractExpression(
  expr: Node
): ExtractedEvent | null {

  // "signup"
  if (Node.isStringLiteral(expr)) {
    return {
      value: expr.getLiteralText(),
      dynamic: false
    };
  }

  // `signup`
  if (
    expr.getKind() ===
    SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return {
      value: expr
        .getText()
        .replace(/`/g, ""),
      dynamic: false
    };
  }

  // template `${event}`
  if (
    Node.isTemplateExpression(expr)
  ) {
    return {
      value: expr.getText(),
      dynamic: true
    };
  }

  // ROUTES.APP
  if (
    Node.isPropertyAccessExpression(expr)
  ) {
    return {
      value: expr.getText(),
      dynamic: true
    };
  }

  // EVENT
  if (
    Node.isIdentifier(expr)
  ) {
    return {
      value: expr.getText(),
      dynamic: true
    };
  }

  // getEvent()
  if (
    Node.isCallExpression(expr)
  ) {
    return {
      value:
        expr
          .getExpression()
          .getText(),
      dynamic: true
    };
  }

  // condition ? "a" : "b"
  if (
    Node.isConditionalExpression(expr)
  ) {
    return {
      value: expr.getText(),
      dynamic: true
    };
  }

  // array[index]
  if (
    Node.isElementAccessExpression(expr)
  ) {
    return {
      value: expr.getText(),
      dynamic: true
    };
  }

  return null;
}
