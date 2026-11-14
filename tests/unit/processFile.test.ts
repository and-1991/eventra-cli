import { describe, expect, it } from "vitest";
import ts from "typescript";
import { processFile } from "../../src/filesystem/processFile";

describe("processFile", () => {
  it("identifies script kind from file extension", async () => {
    const tsx = await processFile("/x.tsx", "export const A = () => null;");
    const tsf = await processFile("/x.ts", "export const A = 1;");
    const jsx = await processFile("/x.jsx", "export const A = () => null;");
    const js = await processFile("/x.js", "module.exports = 1;");

    expect(tsx.scriptKind).toBe(ts.ScriptKind.TSX);
    expect(tsf.scriptKind).toBe(ts.ScriptKind.TS);
    expect(jsx.scriptKind).toBe(ts.ScriptKind.JSX);
    expect(js.scriptKind).toBe(ts.ScriptKind.JS);
  });

  it("extracts import and export-from dependencies", async () => {
    const src = `
      import { a } from "./a";
      import b from "./b";
      import "./side-effect";
      export { c } from "./c";
      export * from "./d";
      const inline = require("./not-extracted");
    `;
    const out = await processFile("/x.ts", src);
    expect(out.dependencies.sort()).toEqual([
      "./a",
      "./b",
      "./c",
      "./d",
      "./side-effect",
    ]);
  });

  it("returns an empty deps list for files with no imports", async () => {
    const out = await processFile("/x.ts", "export const A = 1;");
    expect(out.dependencies).toEqual([]);
  });

  it("does not crash on malformed source", async () => {
    const out = await processFile("/x.ts", "import { from './broken");
    expect(Array.isArray(out.dependencies)).toBe(true);
  });

  it("reports the first syntax error with its line, and still returns the file", async () => {
    const out = await processFile("/x.ts", "const a = 1;\nconst b = ;\nconst c = (;\n");
    expect(out.syntaxError?.line).toBe(2);
    expect(out.syntaxError?.message).toMatch(/expression expected/i);
    expect(out.content).toContain("const c");
  });

  it("reads .mts and .cts as TypeScript without JSX, so a generic arrow or an angle-bracket cast is not a syntax error", async () => {
    const code = 'export const g = <T>(x: T): T => x;\nexport const s = <string>"x";\n';
    for (const name of ["/x.mts", "/x.cts"]) {
      const out = await processFile(name, code);
      expect(out.scriptKind).toBe(ts.ScriptKind.TS);
      expect(out.syntaxError).toBeUndefined();
    }
  });

  it("reads .mjs and .cjs as JavaScript, as .js is", async () => {
    for (const name of ["/x.mjs", "/x.cjs"]) {
      const out = await processFile(name, "export const A = () => 1;");
      expect(out.scriptKind).toBe(ts.ScriptKind.JS);
      expect(out.syntaxError).toBeUndefined();
    }
  });

  it("does not report a valid file, a type error, or TypeScript syntax in a script", async () => {
    expect((await processFile("/x.ts", "export const A: number = 'not a number';")).syntaxError).toBeUndefined();
    expect((await processFile("/x.tsx", "export const A = () => <div>{1}</div>;")).syntaxError).toBeUndefined();
    expect((await processFile("/x.js", "export const A = (a: number) => a;")).syntaxError).toBeUndefined();
  });
});
