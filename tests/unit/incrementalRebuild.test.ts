import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { ImportGraph } from "../../src/compiler/importGraph";
import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";
import { runSeed } from "../differential/harness";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";
const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: { include: ["**/*.ts"], exclude: ["node_modules"] },
};
const HEADER = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst sdk = new Eventra({ apiKey: "k" });\n`;
const LIB = `${HEADER}export function emit(name: string) { sdk.track(name); }\n`;
const CALLER = `import { emit } from "./lib";\nemit("from.caller");\n`;

describe("CompilerContext source file cache", () => {
  const sourceFileOf = (ctx: CompilerContext, file: string): ts.SourceFile =>
    ctx.getProgram().getSourceFile(file)!;

  it("reuses the parsed file of an unchanged document across rebuilds and parses a changed one again", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfcache-"));
    try {
      const ctx = new CompilerContext(root);
      const a = path.join(root, "a.ts");
      const b = path.join(root, "b.ts");
      ctx.stageFile(a, "export const a = 1;\n");
      ctx.stageFile(b, "export const b = 1;\n");
      ctx.flushUpdates();
      const firstA = sourceFileOf(ctx, a);
      const firstB = sourceFileOf(ctx, b);

      ctx.stageFile(b, "export const b = 2;\n");
      ctx.flushUpdates();

      expect(sourceFileOf(ctx, a)).toBe(firstA);
      expect(sourceFileOf(ctx, b)).not.toBe(firstB);
      expect(sourceFileOf(ctx, b).text).toContain("= 2");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never serves stale text for a file that was removed and added again (its version restarts)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfcache-"));
    try {
      const ctx = new CompilerContext(root);
      const a = path.join(root, "a.ts");
      ctx.stageFile(a, "export const a = 'first';\n");
      ctx.flushUpdates();
      expect(sourceFileOf(ctx, a).text).toContain("first");

      ctx.removeFile(a);
      expect(ctx.getProgram().getSourceFile(a)).toBeUndefined();

      ctx.stageFile(a, "export const a = 'second';\n");
      ctx.flushUpdates();
      expect(sourceFileOf(ctx, a).text).toContain("second");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses again when the same text is requested for another language version or script kind", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfcache-"));
    try {
      const ctx = new CompilerContext(root);
      const a = path.join(root, "a.ts");
      ctx.stageFile(a, "export const a = 1;\n");
      const host = (ctx as unknown as { host: ts.CompilerHost }).host;
      const es2015 = host.getSourceFile(a, ts.ScriptTarget.ES2015)!;
      const es2015Again = host.getSourceFile(a, ts.ScriptTarget.ES2015)!;
      const esnext = host.getSourceFile(a, ts.ScriptTarget.ESNext)!;
      expect(es2015Again).toBe(es2015);
      expect(esnext).not.toBe(es2015);
      expect(esnext.languageVersion).toBe(ts.ScriptTarget.ESNext);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ImportGraph change reporting", () => {
  it("reports whether the imports of a file changed", () => {
    const graph = new ImportGraph();
    expect(graph.hasFile("a")).toBe(false);
    expect(graph.updateFile("a", [])).toBe(false);
    expect(graph.hasFile("a")).toBe(true);
    expect(graph.updateFile("a", ["b"])).toBe(true);
    expect(graph.updateFile("a", ["b"])).toBe(false);
    expect(graph.updateFile("a", ["c"])).toBe(true);
    expect(graph.updateFile("a", ["c", "d"])).toBe(true);
    expect(graph.getFiles()).toEqual(["a"]);
  });
});

async function setup(files: Record<string, string>): Promise<{ root: string; engine: EventraEngine; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-edges-"));
  const engine = new EventraEngine(root);
  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
  const names = [SDK_TYPES];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.writeFileSync(abs, content);
    await engine.preloadFile(abs, content);
    names.push(abs);
  }
  engine.endPreload();
  await engine.runFullAnalysis(names, CONFIG);
  return { root, engine, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("EventraEngine import resolution changes without the importer changing", () => {
  it("analyses an importer again when the file it imports is created later", async () => {
    // the import is written before its target exists, the usual order while coding
    const { root, engine, cleanup } = await setup({ "caller.ts": CALLER });
    try {
      expect(engine.getAllEvents()).toEqual([]);

      const lib = path.join(root, "lib.ts");
      fs.writeFileSync(lib, LIB);
      await engine.updateFile(lib, LIB, CONFIG);

      expect(engine.getAllEvents()).toEqual(["from.caller"]);
      expect([...engine.getScanResult(path.join(root, "caller.ts")).events]).toEqual(["from.caller"]);
    } finally {
      cleanup();
    }
  });

  it("drops the events of an importer when its target is deleted and finds them again when it comes back", async () => {
    const { root, engine, cleanup } = await setup({ "lib.ts": LIB, "caller.ts": CALLER });
    try {
      expect(engine.getAllEvents()).toEqual(["from.caller"]);

      const lib = path.join(root, "lib.ts");
      fs.rmSync(lib);
      await engine.removeFile(lib, CONFIG);
      expect(engine.getAllEvents()).toEqual([]);

      fs.writeFileSync(lib, LIB);
      await engine.updateFile(lib, LIB, CONFIG);
      expect(engine.getAllEvents()).toEqual(["from.caller"]);
    } finally {
      cleanup();
    }
  });

  it("does not touch other files when the set of files does not change", async () => {
    const { root, engine, cleanup } = await setup({ "lib.ts": LIB, "caller.ts": CALLER });
    try {
      const lib = path.join(root, "lib.ts");
      await engine.updateFile(lib, `${LIB}// edit\n`, CONFIG);
      expect(engine.getAllEvents()).toEqual(["from.caller"]);
    } finally {
      cleanup();
    }
  });

  it("removing a file nobody imports leaves the rest untouched", async () => {
    const { root, engine, cleanup } = await setup({ "lib.ts": LIB, "caller.ts": CALLER, "alone.ts": `${HEADER}sdk.track("alone");\n` });
    try {
      const alone = path.join(root, "alone.ts");
      fs.rmSync(alone);
      await engine.removeFile(alone, CONFIG);
      expect(engine.getAllEvents()).toEqual(["from.caller"]);
    } finally {
      cleanup();
    }
  });
});

describe("incremental engine equals a fresh scan (randomized differential test)", () => {
  // The full proof (many seeds, 200+ steps, a larger project) is
  // `tsx tests/differential/run.ts`; this keeps a short version in the suite.
  for (const seed of [1, 2]) {
    it(`seed ${seed}`, async () => {
      const report = await runSeed({
        seed,
        steps: 12,
        initialFiles: 6,
        dirs: ["", "sub/"],
        tsconfig: seed % 2 === 0,
      });
      expect(report.mismatches).toEqual([]);
    }, 120_000);
  }
});
