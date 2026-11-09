import ts from "typescript";

const SIGNAL_INPUTS = new Set(["input", "model"]);

/**
 * Whether a class member is an Angular component input: `@Input() name`, `@Input({ required: true }) name`, a setter
 * with `@Input()`, or a signal input (`name = input<string>()`, `input.required<string>()`, `model()`). Its value
 * comes from the parent's template, so what it is set to in the class is only a default.
 */
export function isAngularInput(member: ts.Declaration): boolean {
  const decorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
  const decorated = decorators.some((decorator) => {
    const callee = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
    return ts.isIdentifier(callee) && callee.text === "Input";
  });
  if (decorated) return true;
  if (!ts.isPropertyDeclaration(member) || !member.initializer || !ts.isCallExpression(member.initializer)) return false;
  const callee = member.initializer.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && callee.name.text === "required" && ts.isIdentifier(callee.expression) ? callee.expression.text : undefined;
  return name !== undefined && SIGNAL_INPUTS.has(name);
}
