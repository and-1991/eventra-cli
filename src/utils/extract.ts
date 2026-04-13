import {
  CallExpression,
  Node,
  ObjectLiteralExpression,
} from "ts-morph";

export function extractEvent(
  call: CallExpression,
  path: string
): string | null {
  const parts = path.split(".");

  let node: Node | undefined =
    call.getArguments()[Number(parts[0])];

  if (!node) return null;

  for (let i = 1; i < parts.length; i++) {
    if (
      Node.isObjectLiteralExpression(node)
    ) {
      const obj: ObjectLiteralExpression =
        node;

      const prop =
        obj.getProperty(parts[i]);

      if (!prop) return null;

      if (
        Node.isPropertyAssignment(prop)
      ) {
        const initializer =
          prop.getInitializer();

        if (!initializer) return null;

        node = initializer;
      }
    }
  }

  if (
    node &&
    Node.isStringLiteral(node)
  ) {
    return node.getLiteralText();
  }

  return null;
}
