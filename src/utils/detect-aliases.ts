import {
  SourceFile,
  SyntaxKind,
  Node
} from "ts-morph";

export function detectAliases(source: SourceFile) {
  const aliases: Record<string, string> = {};

  const vars = source.getDescendantsOfKind(SyntaxKind.VariableDeclaration);

  for (const v of vars) {
    const name = v.getName();
    const init = v.getInitializer();
    if (!init) continue;

    // const A = "event"
    if (Node.isStringLiteral(init)) {
      aliases[name] = init.getLiteralText();
      continue;
    }

    // const A = `event`
    if (init.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
      aliases[name] = init.getText().replace(/`/g, "");
      continue;
    }

    // const EVENTS = { CLICK: "click" }
    if (Node.isObjectLiteralExpression(init)) {
      for (const p of init.getProperties()) {
        if (!Node.isPropertyAssignment(p)) continue;

        const key = p.getName();
        const val = p.getInitializer();
        if (!val) continue;

        if (Node.isStringLiteral(val)) {
          aliases[`${name}.${key}`] = val.getLiteralText();
        }
      }
    }
  }

  return aliases;
}
