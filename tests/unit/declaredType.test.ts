import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { isEventraSdkTrackCall } from "../../src/analysis/sdk/isEventraTrackCall";
import { declaredTypeOfIdentifier, memberOfDeclaredType } from "../../src/analysis/shared/declaredType";

// C5 of AUDIT-2026-11-10: the per-call flow analysis is skipped only when the declared type settles the answer.

function withProject<T>(files: Record<string, string>, run: (sf: ts.SourceFile, checker: ts.TypeChecker) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "declared-type-"));
  try {
    const ctx = new CompilerContext(root);
    const shim = path.join(root, "node_modules", "@eventra_dev", "eventra-sdk", "dist", "index.d.ts");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    ctx.updateFile(shim, EVENTRA_SDK_SHIM);
    for (const [rel, content] of Object.entries(files)) ctx.updateFile(path.join(root, rel), content);
    return run(ctx.getSourceFile(path.join(root, "app.ts"))!, ctx.getChecker());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function lastCall(sf: ts.SourceFile): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) found = n;
    ts.forEachChild(n, visit);
  };
  visit(sf.statements[sf.statements.length - 1]);
  return found!;
}

/** The receiver `x` of the last `x.m(...)` call in app.ts. */
const receiverOf = (sf: ts.SourceFile) => (lastCall(sf).expression as ts.PropertyAccessExpression).expression;

describe("declaredTypeOfIdentifier", () => {
  it("is undefined for what is not a plain identifier, has no symbol, or is not a variable", () => {
    withProject({ "app.ts": "function f() { return { m() {} }; }\nf().m();\nundeclared.m();\nf.call(null);" }, (sf, checker) => {
      const calls: ts.CallExpression[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) calls.push(n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      const receivers = calls.map((c) => (c.expression as ts.PropertyAccessExpression).expression);
      expect(receivers.map((r) => declaredTypeOfIdentifier(r, checker))).toEqual([undefined, undefined, undefined]);
    });
  });

  it.each([
    ["any", "declare const x: any;\nx.m();"],
    ["unknown", "declare const x: unknown;\n(x as any).m();\nx.toString();"],
    ["a generic", "function f<T extends { m(): void }>(x: T) { x.m(); }"],
    ["a union with a generic in it", "function f<T extends { m(): void }>(x: T | { m(): void }) { x.m(); }"],
  ])("is undefined for %s, which narrowing could change", (_label, code) => {
    withProject({ "app.ts": code }, (sf, checker) => {
      expect(declaredTypeOfIdentifier(receiverOf(sf), checker)).toBeUndefined();
    });
  });

  it("follows an import to the declared type of what is exported", () => {
    withProject(
      { "seg.ts": "export const analytics = { track(name: string) {} };", "app.ts": 'import { analytics } from "./seg";\nanalytics.track("x");' },
      (sf, checker) => {
        const declared = declaredTypeOfIdentifier(receiverOf(sf), checker)!;
        expect(checker.getPropertyOfType(declared, "track")).toBeDefined();
      },
    );
  });
});

describe("memberOfDeclaredType", () => {
  it("reads the member of a single object type", () => {
    withProject({ "app.ts": "const a = { track(n: string) {} };\na.track('x');" }, (sf, checker) => {
      const call = lastCall(sf);
      const access = call.expression as ts.PropertyAccessExpression;
      expect(memberOfDeclaredType(access.expression, "track", checker)).toBe(checker.getSymbolAtLocation(access.name));
    });
  });

  it.each([
    ["a union, where narrowing picks the member", "declare const a: { track(): void } | { track(n: string): void };\na.track('x');"],
    ["a primitive", "const a = 'text';\na.toString();"],
    ["an open type", "declare const a: any;\na.track();"],
  ])("is undefined for %s", (_label, code) => {
    withProject({ "app.ts": code }, (sf, checker) => {
      const access = lastCall(sf).expression as ts.PropertyAccessExpression;
      expect(memberOfDeclaredType(access.expression, access.name.text, checker)).toBeUndefined();
    });
  });
});

describe("SDK detection still sees narrowed receivers", () => {
  const sdk = 'import { Eventra } from "@eventra_dev/eventra-sdk";\n';

  it.each([
    ["any narrowed by instanceof", `${sdk}declare const x: any;\nif (x instanceof Eventra) x.track("a");`],
    ["unknown narrowed by instanceof", `${sdk}declare const x: unknown;\nif (x instanceof Eventra) x.track("a");`],
    ["a union with the SDK in it", `${sdk}declare const x: Eventra | { track(n: string): void };\nx.track("a");`],
    ["an auto-typed let", `${sdk}let x;\nx = new Eventra({ apiKey: "k" });\nx.track("a");`],
    [
      "a let assigned twice, next to an assignment to an undeclared name",
      `${sdk}let x: any;\nx = null;\nundeclaredName = 1;\nx = new Eventra({ apiKey: "k" });\nx.track("a");`,
    ],
  ])("detects %s", (_label, code) => {
    withProject({ "app.ts": code }, (sf, checker) => {
      expect(isEventraSdkTrackCall(lastCall(sf), checker)).toBe(true);
    });
  });

  it("does not take a concrete non-SDK object for the SDK", () => {
    withProject({ "app.ts": `${sdk}const analytics = { track(n: string) {} };\nanalytics.track("a");` }, (sf, checker) => {
      expect(isEventraSdkTrackCall(lastCall(sf), checker)).toBe(false);
    });
  });
});
