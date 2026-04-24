import {
  SourceFile,
  SyntaxKind,
  Node,
  CallExpression,
  PropertyAccessExpression,
} from "ts-morph";

import {
  FunctionWrapper,
  ExtractedEvent
} from "../../types";

import { extractExpression } from "../extract";

export function scanFunctionWrappers(
  source: SourceFile,
  wrappers: FunctionWrapper[],
  aliases: Record<string, string>
) {
  const events = new Map<string, ExtractedEvent>();

  const calls =
    source.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );

  for (const call of calls) {
    const name = getFunctionName(call);
    if (!name) continue;

    for (const wrapper of wrappers) {
      if (wrapper.name !== name) continue;

      const results = extractEventFromArgs(
        call,
        wrapper.event,
        aliases
      );

      if (!results) continue;

      for (const r of results) {
        const key = `${r.value}:${r.dynamic}`;
        events.set(key, r);
      }
    }
  }

  return [...events.values()];
}

function getFunctionName(
  call: CallExpression
): string | null {

  const expression = call.getExpression();

  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return getDeepName(expression);
  }

  return null;
}

function getDeepName(
  node: PropertyAccessExpression
): string {

  let current: Node | undefined = node;
  let name = "";

  while (Node.isPropertyAccessExpression(current)) {
    name = current.getName();
    current = current.getExpression();
  }

  return name;
}

function extractEventFromArgs(
  call: CallExpression,
  event: string | undefined,
  aliases: Record<string, string>
): ExtractedEvent[] | null {

  const args = call.getArguments();
  const events: ExtractedEvent[] = [];

  for (const arg of args) {

    // track("event")
    if (!event) {
      const result = extractExpression(arg, aliases);
      if (!result) continue;

      result.values.forEach((value) =>
        events.push({
          value,
          dynamic: result.dynamic
        })
      );
    }

    // track({ event })
    if (event) {
      const obj = arg.asKind(
        SyntaxKind.ObjectLiteralExpression
      );
      if (!obj) continue;

      const prop = obj.getProperty(event);
      if (!prop) continue;

      if (Node.isPropertyAssignment(prop)) {
        const init = prop.getInitializer();
        if (!init) continue;

        const result = extractExpression(init, aliases);
        if (!result) continue;

        result.values.forEach((value) =>
          events.push({
            value,
            dynamic: result.dynamic
          })
        );
      }
    }
  }

  return events.length ? events : null;
}
