import ts from "typescript";
import { describe, expect, it } from "vitest";

import { isAngularInput } from "../../src/analysis/symbols/angularInput";

const members = (body: string): Map<string, ts.ClassElement> => {
  const source = ts.createSourceFile("c.ts", `class C {\n${body}\n}`, ts.ScriptTarget.Latest, true);
  const cls = source.statements[0] as ts.ClassDeclaration;
  return new Map(cls.members.map((member) => [(member.name as ts.Identifier).text, member]));
};

describe("isAngularInput", () => {
  const parsed = members(`
    @Input() a = "";
    @Input({ required: true }) b!: string;
    @Input c!: string;
    @Output() out = null;
    @Other() other = "";
    plain = "";
    fromCall = compute();
    s1 = input<string>();
    s2 = input.required<string>();
    s3 = model<number>();
    notSignal = other.required<string>();
    notSignal2 = something.input();
    @Input() set d(value: string) {}
    method() {}
  `);
  const yes = (name: string): boolean => isAngularInput(parsed.get(name)! as ts.Declaration);

  it("a field or a setter with @Input, called or not", () => {
    for (const name of ["a", "b", "c", "d"]) expect(yes(name)).toBe(true);
  });

  it("a signal input: input(), input.required() and model()", () => {
    for (const name of ["s1", "s2", "s3"]) expect(yes(name)).toBe(true);
  });

  it("a declaration that cannot carry a decorator at all (a variable) is not an input", () => {
    const source = ts.createSourceFile("v.ts", "const x = input<string>();", ts.ScriptTarget.Latest, true);
    const declaration = (source.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    expect(isAngularInput(declaration)).toBe(false);
  });

  it("other decorators, plain fields, other calls and methods are not inputs", () => {
    for (const name of ["out", "other", "plain", "fromCall", "notSignal", "notSignal2", "method"]) expect(yes(name)).toBe(false);
  });
});
