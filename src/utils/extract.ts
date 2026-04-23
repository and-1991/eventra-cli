import {
  Node,
  SyntaxKind
} from "ts-morph";

export type ExtractResult = {
  values: string[];
  dynamic: boolean;
};

export function extractExpression(
  expr: Node
): ExtractResult | null {

  // "event"
  if (Node.isStringLiteral(expr)) {
    return {
      values: [expr.getLiteralText()],
      dynamic: false
    };
  }

  // `event`
  if (
    expr.getKind() ===
    SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return {
      values: [
        expr.getText().replace(/`/g, "")
      ],
      dynamic: false
    };
  }

  // identifier (TEST)
  if (Node.isIdentifier(expr)) {
    const name = expr.getText();

    const defs =
      "getDefinitions" in expr
        ? (expr as any).getDefinitions()
        : [];

    if (defs && defs.length > 0) {
      const decl = defs[0]?.getDeclarationNode();

      if (decl && Node.isVariableDeclaration(decl)) {
        const initializer = decl.getInitializer();

        // const TEST = "event"
        if (
          initializer &&
          Node.isStringLiteral(initializer)
        ) {
          return {
            values: [initializer.getLiteralText()],
            dynamic: false
          };
        }

        // const TEST = `event`
        if (
          initializer &&
          initializer.getKind() ===
          SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
          return {
            values: [
              initializer.getText().replace(/`/g, "")
            ],
            dynamic: false
          };
        }
      }
    }

    return {
      values: [name],
      dynamic: true
    };
  }

  // property access (EVENTS.CLICK)
  if (Node.isPropertyAccessExpression(expr)) {
    const fullName = expr.getText(); // EVENTS.CLICK
    const propName = expr.getName(); // CLICK

    const defs =
      "getDefinitions" in expr
        ? (expr as any).getDefinitions()
        : [];

    if (defs && defs.length > 0) {
      const decl = defs[0]?.getDeclarationNode();

      // const EVENTS = { CLICK: "event" }
      if (decl && Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();

        if (init && Node.isObjectLiteralExpression(init)) {
          const prop = init.getProperty(propName);

          if (
            prop &&
            Node.isPropertyAssignment(prop)
          ) {
            const value = prop.getInitializer();

            if (
              value &&
              Node.isStringLiteral(value)
            ) {
              return {
                values: [value.getLiteralText()],
                dynamic: false
              };
            }
          }
        }
      }

      // fallback
      if (decl && Node.isPropertyAssignment(decl)) {
        const initializer = decl.getInitializer();

        if (
          initializer &&
          Node.isStringLiteral(initializer)
        ) {
          return {
            values: [initializer.getLiteralText()],
            dynamic: false
          };
        }
      }
    }

    return {
      values: [fullName],
      dynamic: true
    };
  }

  // ternary (a ? b : c)
  if (Node.isConditionalExpression(expr)) {
    const values: string[] = [];

    const whenTrue =
      extractExpression(expr.getWhenTrue());

    const whenFalse =
      extractExpression(expr.getWhenFalse());

    if (whenTrue) values.push(...whenTrue.values);
    if (whenFalse) values.push(...whenFalse.values);

    return {
      values,
      dynamic: true
    };
  }

  // template `${}`
  if (Node.isTemplateExpression(expr)) {
    return {
      values: [
        expr.getText().replace(/`/g, "")
      ],
      dynamic: true
    };
  }

  // call (fn())
  if (Node.isCallExpression(expr)) {
    return {
      values: [
        expr.getExpression().getText()
      ],
      dynamic: true
    };
  }

  return null;
}
