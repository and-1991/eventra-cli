import {
  SourceFile,
  SyntaxKind,
  Node,
} from "ts-morph";

import { ExtractedEvent, EventraConfig } from "../../types";
import { extractExpression } from "../extract";

export function scanTrack(
  source: SourceFile,
  config: EventraConfig
) {
  const events = new Set<ExtractedEvent>();

  const calls = source.getDescendantsOfKind(
    SyntaxKind.CallExpression
  );

  for (const call of calls) {
    const expr = call.getExpression();

    let isTrack = false;

    // track()
    if (Node.isIdentifier(expr)) {
      isTrack = expr.getText() === "track";
    }

    // analytics.track()
    if (Node.isPropertyAccessExpression(expr)) {
      isTrack = expr.getName() === "track";
    }

    if (!isTrack) continue;

    const func =
      call.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
      call.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ||
      call.getFirstAncestorByKind(SyntaxKind.FunctionExpression);

    let fnName: string | undefined;

    if (func) {
      if (Node.isFunctionDeclaration(func)) {
        fnName = func.getName();
      }

      if (
        Node.isArrowFunction(func) ||
        Node.isFunctionExpression(func)
      ) {
        const varDecl = func.getFirstAncestorByKind(
          SyntaxKind.VariableDeclaration
        );
        fnName = varDecl?.getName();
      }
    }

    if (
      fnName &&
      config.functionWrappers?.some(
        (w) => w.name === fnName
      )
    ) {
      continue;
    }

    const arg = call.getArguments()[0];
    if (!arg) continue;

    const result = extractExpression(arg);
    if (!result) continue;

    result.values.forEach((value) =>
      events.add({
        value,
        dynamic: result.dynamic,
      })
    );
  }

  return events;
}
