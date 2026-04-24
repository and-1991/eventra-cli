import {
  SourceFile,
  SyntaxKind,
  Node,
  CallExpression
} from "ts-morph";

export type FunctionWrapper = {
  name: string;
  event?: string;
};

export type ComponentWrapper = {
  name: string;
  prop: string;
};

export function detectWrappers(source: SourceFile) {
  return {
    functions: detectFunctionWrappers(source),
    components: detectComponentWrappers(source)
  };
}

// FUNCTIONS
function detectFunctionWrappers(source: SourceFile): FunctionWrapper[] {
  const result = new Map<string, FunctionWrapper>();

  const functions = [
    ...source.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...source.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...source.getDescendantsOfKind(SyntaxKind.FunctionExpression)
  ];

  for (const fn of functions) {
    const body = fn.getBody();
    if (!body) continue;

    const calls = body.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of calls) {
      if (!isTrackCall(call)) continue;

      const name = getFunctionName(fn);
      if (!name) continue;

      const arg = call.getArguments()[0];

      let eventField: string | undefined;

      if (arg && Node.isObjectLiteralExpression(arg)) {
        const prop = arg.getProperties()[0];
        if (prop && Node.isPropertyAssignment(prop)) {
          eventField = prop.getName();
        }
      }

      result.set(name, { name, event: eventField });
    }
  }

  return [...result.values()];
}

function isTrackCall(call: CallExpression) {
  const expr = call.getExpression();

  if (Node.isIdentifier(expr)) {
    return expr.getText() === "track";
  }

  if (Node.isPropertyAccessExpression(expr)) {
    return expr.getName() === "track";
  }

  return false;
}

function getFunctionName(fn: Node): string | null {
  if (Node.isFunctionDeclaration(fn)) {
    return fn.getName() ?? null;
  }

  const varDecl = fn.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return varDecl?.getName() ?? null;
}

// COMPONENTS
function detectComponentWrappers(source: SourceFile): ComponentWrapper[] {
  const result = new Map<string, ComponentWrapper>();

  const elements = [
    ...source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
  ];

  for (const el of elements) {
    const name = el.getTagNameNode().getText();

    for (const attr of el.getAttributes()) {
      const a = attr.asKind(SyntaxKind.JsxAttribute);
      if (!a) continue;

      const prop = a.getNameNode().getText();
      const val = a.getInitializer();

      if (!val) continue;

      if (
        Node.isStringLiteral(val) ||
        Node.isJsxExpression(val)
      ) {
        result.set(name, { name, prop });
      }
    }
  }

  return [...result.values()];
}
