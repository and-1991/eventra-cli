import { Node, ObjectLiteralExpression, ts } from "ts-morph";
import { resolveNodeValue } from "./resolver";

export type Extracted = {
  value: string;
  dynamic: boolean;
};

export function extractEventsFromArgs(
  args: Node[],
  checker: ts.TypeChecker
): Extracted[] {
  return args.flatMap(arg => extract(arg, checker));
}

function extract(node: Node, checker: ts.TypeChecker): Extracted[] {
  if (Node.isStringLiteral(node)) {
    return [{ value: node.getLiteralText(), dynamic: false }];
  }

  if (Node.isNoSubstitutionTemplateLiteral(node)) {
    return [{ value: node.getLiteralText(), dynamic: false }];
  }

  if (Node.isTemplateExpression(node)) {
    let result = node.getHead().getLiteralText();

    for (const span of node.getTemplateSpans()) {
      result += "*";
      result += span.getLiteral().getLiteralText();
    }

    return [{ value: result, dynamic: true }];
  }

  if (Node.isObjectLiteralExpression(node)) {
    return extractObject(node, checker);
  }

  const resolved = resolveNodeValue(node, checker);
  if (resolved) {
    return resolved.values.map(v => ({
      value: v,
      dynamic: resolved.dynamic,
    }));
  }

  return [];
}

function extractObject(
  obj: ObjectLiteralExpression,
  checker: ts.TypeChecker
): Extracted[] {
  const res: Extracted[] = [];

  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;

    const name = prop.getName();
    const init = prop.getInitializer();
    if (!init) continue;

    if (["event", "name", "action", "type"].includes(name)) {
      res.push(...extract(init, checker));
    }

    if (Node.isObjectLiteralExpression(init)) {
      res.push(...extractObject(init, checker));
    }
  }

  return res;
}
