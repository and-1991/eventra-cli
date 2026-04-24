import {
  SourceFile,
  SyntaxKind,
  Node
} from "ts-morph";

import {
  ComponentWrapper,
  ExtractedEvent
} from "../../types";

import { extractExpression } from "../extract";

export function scanComponentWrappers(
  source: SourceFile,
  wrappers: ComponentWrapper[],
  aliases: Record<string, string>
) {
  const events = new Map<string, ExtractedEvent>();

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
      if (name !== wrapper.name.toLowerCase())
        continue;

      for (const attr of el.getAttributes()) {

        if (Node.isJsxSpreadAttribute(attr))
          continue;

        const attrNode =
          attr.asKind(SyntaxKind.JsxAttribute);

        if (!attrNode) continue;

        const key =
          attrNode
            .getNameNode()
            .getText()
            .toLowerCase();

        if (key !== wrapper.prop.toLowerCase())
          continue;

        const init = attrNode.getInitializer();

        // <Button event />
        if (!init) {
          const value = key;
          const k = `${value}:true`;

          events.set(k, {
            value,
            dynamic: true
          });

          continue;
        }

        // <Button event="click" />
        if (Node.isStringLiteral(init)) {
          const value = init.getLiteralText();
          const k = `${value}:false`;

          events.set(k, {
            value,
            dynamic: false
          });

          continue;
        }

        // <Button event={...} />
        if (Node.isJsxExpression(init)) {
          const expr = init.getExpression();
          if (!expr) continue;

          const result = extractExpression(expr, aliases);
          if (!result) continue;

          for (const value of result.values) {
            const k = `${value}:${result.dynamic}`;

            events.set(k, {
              value,
              dynamic: result.dynamic
            });
          }
        }
      }
    }
  }

  return [...events.values()];
}
