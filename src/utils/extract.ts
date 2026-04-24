import { Node, SyntaxKind } from "ts-morph";

export type ExtractResult = {
  values: string[];
  dynamic: boolean;
};

export function extractExpression(
  expr: Node,
  aliases: Record<string, string>
): ExtractResult | null {

  // "event"
  if (Node.isStringLiteral(expr)) {
    return {
      values: [expr.getLiteralText()],
      dynamic: false
    };
  }

  // `event`
  if (expr.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return {
      values: [expr.getText().replace(/`/g, "")],
      dynamic: false
    };
  }

  // IDENTIFIER
  if (Node.isIdentifier(expr)) {
    const name = expr.getText();

    if (name in aliases) {
      return {
        values: [aliases[name]],
        dynamic: false
      };
    }

    return {
      values: [name],
      dynamic: true
    };
  }

  // PROPERTY ACCESS
  if (Node.isPropertyAccessExpression(expr)) {
    const name = expr.getText();

    if (name in aliases) {
      return {
        values: [aliases[name]],
        dynamic: false
      };
    }

    return {
      values: [name],
      dynamic: true
    };
  }

  // template `${}`
  if (Node.isTemplateExpression(expr)) {
    return {
      values: [expr.getText()],
      dynamic: true
    };
  }

  return null;
}
