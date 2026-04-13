import {
  SourceFile,
  SyntaxKind,
  Node,
  CallExpression,
  PropertyAccessExpression,
} from "ts-morph";

import { extractExpression } from "../extract";
import { FunctionWrapper, ExtractedEvent } from "../../types";

export function scanFunctionWrappers(
  source: SourceFile,
  wrappers: FunctionWrapper[]
) {
  const events =
    new Set<ExtractedEvent>();

  const calls =
    source.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );

  for (const call of calls) {
    const name =
      getFunctionName(call);

    if (!name) continue;

    for (const wrapper of wrappers) {
      if (wrapper.name !== name)
        continue;

      const result =
        extractEventFromArgs(
          call,
          wrapper.event
        );

      if (result)
        events.add(result);
    }
  }

  return events;
}

function getFunctionName(
  call: CallExpression
): string | null {
  const expression =
    call.getExpression();

  if (
    Node.isIdentifier(expression)
  ) {
    return expression.getText();
  }

  if (
    Node.isPropertyAccessExpression(
      expression
    )
  ) {
    return getDeepName(
      expression
    );
  }

  return null;
}

function getDeepName(
  node: PropertyAccessExpression
): string {
  let current:
    | Node
    | undefined = node;

  let name = "";

  while (
    Node.isPropertyAccessExpression(
      current
    )
    ) {
    name =
      current.getName();

    current =
      current.getExpression();
  }

  return name;
}

function extractEventFromArgs(
  call: CallExpression,
  event?: string
): ExtractedEvent | null {

  const args =
    call.getArguments();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // track("event")
    if (!event) {
      const result =
        extractExpression(arg);

      if (result)
        return result;
    }

    // track({ event: "..." })
    if (event) {
      const obj =
        arg.asKind(
          SyntaxKind.ObjectLiteralExpression
        );

      if (!obj) continue;

      const prop =
        obj.getProperty(event);

      if (!prop) continue;

      if (
        Node.isPropertyAssignment(prop)
      ) {
        const init =
          prop.getInitializer();

        if (!init) continue;

        return extractExpression(
          init
        );
      }
    }
  }

  return null;
}
