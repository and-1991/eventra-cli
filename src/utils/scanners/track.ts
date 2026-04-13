import {
  SourceFile,
  SyntaxKind
} from "ts-morph";

export function scanTrack(
  source: SourceFile
) {
  const events =
    new Set<string>();

  const calls =
    source.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );

  for (const call of calls) {
    const expr =
      call.getExpression();

    let isTrack = false;

    // track()
    if (
      expr.getKind() ===
      SyntaxKind.Identifier
    ) {
      isTrack =
        expr.getText() === "track";
    }

    // analytics.track()
    if (
      expr.getKind() ===
      SyntaxKind.PropertyAccessExpression
    ) {
      const prop =
        expr.asKindOrThrow(
          SyntaxKind.PropertyAccessExpression
        );

      isTrack =
        prop.getName() === "track";
    }

    if (!isTrack) continue;

    const arg =
      call.getArguments()[0];

    if (!arg) continue;

    if (
      arg.getKind() ===
      SyntaxKind.StringLiteral
    ) {
      const value =
        arg.asKindOrThrow(
          SyntaxKind.StringLiteral
        );

      events.add(
        value.getLiteralText()
      );
    }

    // template literal
    if (
      arg.getKind() ===
      SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      const value =
        arg.asKindOrThrow(
          SyntaxKind.NoSubstitutionTemplateLiteral
        );

      events.add(
        value.getLiteralText()
      );
    }
  }

  return events;
}
