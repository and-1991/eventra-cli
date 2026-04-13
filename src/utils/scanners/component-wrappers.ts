import {
  SourceFile,
  SyntaxKind,
} from "ts-morph";

import { ComponentWrapper } from "../../types";

export function scanComponentWrappers(
  source: SourceFile,
  wrappers: ComponentWrapper[]
) {
  const events = new Set<string>();

  const elements = [
    ...source.getDescendantsOfKind(
      SyntaxKind.JsxOpeningElement
    ),
    ...source.getDescendantsOfKind(
      SyntaxKind.JsxSelfClosingElement
    )
  ];

  for (const el of elements) {
    const name = el
      .getTagNameNode()
      .getText()
      .toLowerCase();

    for (const wrapper of wrappers) {
      if (
        name !==
        wrapper.name.toLowerCase()
      )
        continue;

      const attrs =
        el.getAttributes();

      for (const attr of attrs) {
        const attrNode =
          attr.asKind(
            SyntaxKind.JsxAttribute
          );

        if (!attrNode) continue;

        const key =
          attrNode
            .getNameNode()
            .getText()
            .toLowerCase();

        if (
          key !==
          wrapper.prop.toLowerCase()
        )
          continue;

        const init =
          attrNode.getInitializer();

        if (!init) continue;

        // event="signup"
        if (
          init.getKind() ===
          SyntaxKind.StringLiteral
        ) {
          const value =
            init.asKindOrThrow(
              SyntaxKind.StringLiteral
            );

          events.add(
            value.getLiteralText()
          );
        }

        // event={"signup"}
        if (
          init.getKind() ===
          SyntaxKind.JsxExpression
        ) {
          const expr =
            init
              .asKindOrThrow(
                SyntaxKind.JsxExpression
              )
              .getExpression();

          if (
            expr?.getKind() ===
            SyntaxKind.StringLiteral
          ) {
            const value =
              expr.asKindOrThrow(
                SyntaxKind.StringLiteral
              );

            events.add(
              value.getLiteralText()
            );
          }
        }
      }
    }
  }

  return events;
}
