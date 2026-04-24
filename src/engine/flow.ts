import {
  Node,
  SyntaxKind,
  FunctionDeclaration,
  ArrowFunction,
  FunctionExpression
} from "ts-morph";

type Fn =
  | FunctionDeclaration
  | ArrowFunction
  | FunctionExpression;

function getBodyNodes(fn: Fn) {
  const body = fn.getBody();
  if (!body) return [];

  if (Node.isBlock(body)) return body.getStatements();
  return [body];
}

export function getForwardedParamIndex(fn: Node): number | null {
  if (
    !Node.isFunctionDeclaration(fn) &&
    !Node.isArrowFunction(fn) &&
    !Node.isFunctionExpression(fn)
  ) return null;

  const f = fn as Fn;
  const params = f.getParameters();

  for (const node of getBodyNodes(f)) {
    const calls = node.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of calls) {
      const name = call.getExpression().getText();

      if (!/(track|event|log|analytics|capture|send)/i.test(name)) continue;

      const args = call.getArguments();

      for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (Node.isIdentifier(arg)) {
          const idx = params.findIndex(p => p.getName() === arg.getText());
          if (idx !== -1) return idx;
        }
      }
    }
  }

  return null;
}
