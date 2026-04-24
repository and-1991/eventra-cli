import { SourceFile, SyntaxKind, Node, ts } from "ts-morph";
import { extractEventsFromArgs } from "./extract";
import { resolveFunctionFromCall } from "./callResolver";
import { getForwardedParamIndex } from "./flow";

function getCallName(expr: Node): string {
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  return expr.getText();
}

function isTrackLike(name: string) {
  return /(track|trackFeature)/i.test(name);
}

function pickArg(args: Node[]) {
  return (
    args.find(Node.isStringLiteral) ??
    args.find(Node.isTemplateExpression) ??
    args.find(Node.isObjectLiteralExpression) ??
    args[0]
  );
}

export function scanSource(
  source: SourceFile,
  checker: ts.TypeChecker
) {
  const events = new Set<string>();

  // CALLS
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const name = getCallName(expr);

    if (!isTrackLike(name)) continue;

    const args = call.getArguments();
    if (!args.length) continue;

    let target = pickArg(args);

    const fn = resolveFunctionFromCall(expr);

    if (fn) {
      const index = getForwardedParamIndex(fn);
      if (index !== null && args[index]) {
        target = args[index];
      }
    }

    extractEventsFromArgs([target], checker).forEach(({ value }) => {
      if (isValid(value)) events.add(value);
    });
  }

  // JSX
  const jsx = [
    ...source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];

  for (const el of jsx) {
    for (const attr of el.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) continue;

      const name = attr.getNameNode().getText();
      if (!/(event|name|action)/i.test(name)) continue;

      const init = attr.getInitializer();
      if (!init) continue;

      const expr = Node.isJsxExpression(init)
        ? init.getExpression()
        : init;

      if (!expr) continue;

      extractEventsFromArgs([expr], checker).forEach(({ value }) => {
        if (isValid(value)) events.add(value);
      });
    }
  }

  return events;
}

function isValid(v: string) {
  return !!v && v.length > 1 && !v.includes(" ");
}
