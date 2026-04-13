import {
  SourceFile,
  SyntaxKind,
  Node
} from "ts-morph";

import { ComponentWrapper, ExtractedEvent } from "../../types";
import { extractExpression } from "../extract";

export function scanComponentWrappers(
  source: SourceFile,
  wrappers: ComponentWrapper[]
) {
  const events =
    new Set<ExtractedEvent>();

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
          Node.isStringLiteral(init)
        ) {
          events.add({
            value:
              init.getLiteralText(),
            dynamic: false
          });
        }

        // event={...}
        if (
          Node.isJsxExpression(init)
        ) {
          const expr =
            init.getExpression();

          if (!expr) continue;

          const result =
            extractExpression(expr);

          if (result)
            events.add(result);
        }
      }
    }
  }

  return events;
}
