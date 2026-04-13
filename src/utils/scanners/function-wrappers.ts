import {
  SourceFile,
  SyntaxKind,
} from "ts-morph";

import { extractEvent } from "../extract";
import { FunctionWrapper } from "../../types";

export function scanFunctionWrappers(
  source: SourceFile,
  wrappers: FunctionWrapper[]
) {
  const events =
    new Set<string>();

  const calls =
    source.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );

  for (const call of calls) {
    const expression =
      call.getExpression();

    let name: string | null = null;

    // trackFeature()
    if (
      expression.getKind() ===
      SyntaxKind.Identifier
    ) {
      name =
        expression.getText();
    }

    // analytics.trackFeature()
    if (
      expression.getKind() ===
      SyntaxKind.PropertyAccessExpression
    ) {
      const prop =
        expression.asKindOrThrow(
          SyntaxKind.PropertyAccessExpression
        );

      name = prop.getName();
    }

    if (!name) continue;

    for (const wrapper of wrappers) {
      if (name !== wrapper.name)
        continue;

      const event =
        extractEvent(
          call,
          wrapper.path
        );

      if (event)
        events.add(event);
    }
  }

  return events;
}
