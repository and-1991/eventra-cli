import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventraEngine } from "../../src/core/EventraEngine";
import { CompilerContext } from "../../src/compiler/compilerContext";
import { DocumentRegistry } from "../../src/compiler/documentRegistry";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: { include: ["**/*.ts"], exclude: ["node_modules"] },
};

const HEADER = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst sdk = new Eventra({ apiKey: "k" });\n`;
// a.ts imports the wrapper from lib.ts, so a flush touching both exercises the
// import graph, not just independent files
const LIB = `import { Eventra } from "@eventra_dev/eventra-sdk";
const sdk = new Eventra({ apiKey: "k" });
export function emit(name: string) { sdk.track(name); }
`;
const FILES: Record<string, string> = {
  "lib.ts": LIB,
  "a.ts": `import { emit } from "./lib";\nemit("a.one");\n`,
  "b.ts": `${HEADER}sdk.track("b.one");\n`,
  "c.ts": `${HEADER}sdk.track("c.one");\n`,
};
const UPDATES: Record<string, string> = {
  "a.ts": `import { emit } from "./lib";\nemit("a.two");\n`,
  "b.ts": `${HEADER}sdk.track("b.two");\n`,
  // brand new file that only exists in memory, imported by c.ts in the same flush
  "d.ts": `${HEADER}sdk.track("d.one");\nexport const d = 1;\n`,
  "c.ts": `import { d } from "./d";\n${HEADER}sdk.track("c.two");\nvoid d;\n`,
};

async function setup(): Promise<{ root: string; engine: EventraEngine; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-batch-"));
  const engine = new EventraEngine(root);
  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
  const names = [SDK_TYPES];
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    fs.writeFileSync(abs, content);
    await engine.preloadFile(abs, content);
    names.push(abs);
  }
  engine.endPreload();
  await engine.runFullAnalysis(names, CONFIG);
  return { root, engine, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function countRebuilds(): { count: () => number; restore: () => void } {
  const proto = CompilerContext.prototype as unknown as { rebuildProgram: () => void };
  const original = proto.rebuildProgram;
  let n = 0;
  proto.rebuildProgram = function (this: CompilerContext) {
    n++;
    return original.call(this);
  };
  return { count: () => n, restore: () => (proto.rebuildProgram = original) };
}

describe("EventraEngine batched flush", () => {
  it("rebuilds the program once for a multi-file flush and yields the same events as sequential updates", async () => {
    const batched = await setup();
    const sequential = await setup();
    const spy = countRebuilds();
    try {
      // same tick: the scheduler batches these into one flush
      const before = spy.count();
      await Promise.all(
        Object.entries(UPDATES).map(([rel, content]) =>
          batched.engine.updateFile(path.join(batched.root, rel), content, CONFIG),
        ),
      );
      expect(spy.count() - before).toBe(1);

      // awaited one by one: one flush (and rebuild) per file
      const seqBefore = spy.count();
      for (const [rel, content] of Object.entries(UPDATES)) {
        await sequential.engine.updateFile(path.join(sequential.root, rel), content, CONFIG);
      }
      expect(spy.count() - seqBefore).toBe(Object.keys(UPDATES).length);

      expect(batched.engine.getAllEvents()).toEqual(sequential.engine.getAllEvents());
      expect(batched.engine.getAllEvents()).toEqual([
        "a.two",
        "b.two",
        "c.two",
        "d.one",
      ]);
      expect(batched.engine.getAllFunctionWrappers()).toEqual(
        sequential.engine.getAllFunctionWrappers(),
      );
      for (const rel of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
        expect([...batched.engine.getScanResult(path.join(batched.root, rel)).events].sort()).toEqual(
          [...sequential.engine.getScanResult(path.join(sequential.root, rel)).events].sort(),
        );
      }
    } finally {
      spy.restore();
      batched.cleanup();
      sequential.cleanup();
    }
  });

  it("builds the program lazily: not in the constructor, once per preload", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-lazy-"));
    const spy = countRebuilds();
    try {
      const engine = new EventraEngine(root);
      expect(spy.count()).toBe(0);
      engine.beginPreload();
      await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
      expect(spy.count()).toBe(0);
      engine.endPreload();
      expect(spy.count()).toBe(1);
    } finally {
      spy.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CompilerContext resolution cache scope", () => {
  it("does not keep resolutions between batches, so a file created on disk is found next time", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cache-"));
    try {
      fs.writeFileSync(path.join(root, "main.ts"), `import "./later";\n`);
      const compiler = new CompilerContext(root);
      const main = path.join(root, "main.ts");
      compiler.stageFile(main, `import "./later";\n`);
      compiler.flushUpdates();
      const first = compiler.withResolutionCache(() => compiler.resolveModule("./later", main));
      expect(first).toBeUndefined();

      fs.writeFileSync(path.join(root, "later.ts"), "export const x = 1;\n");
      const second = compiler.withResolutionCache(() => compiler.resolveModule("./later", main));
      expect(second?.endsWith("later.ts")).toBe(true);
      // nested use shares the outer cache and still returns the value
      expect(compiler.withResolutionCache(() => compiler.withResolutionCache(() => 7))).toBe(7);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("DocumentRegistry.normalize memo", () => {
  it("returns the same result as path.resolve and follows a cwd change for relative paths", () => {
    const registry = new DocumentRegistry();
    const original = process.cwd();
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "reg-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "reg-b-"));
    try {
      process.chdir(a);
      const first = registry.normalize("x.ts");
      expect(first).toBe(path.resolve("x.ts").replace(/\\/g, "/"));
      expect(registry.normalize("x.ts")).toBe(first);
      process.chdir(b);
      const second = registry.normalize("x.ts");
      expect(second).toBe(path.resolve("x.ts").replace(/\\/g, "/"));
      expect(second).not.toBe(first);
      expect(registry.normalize("C:\\dir\\file.ts").includes("\\")).toBe(false);
    } finally {
      process.chdir(original);
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe("EventraEngine lazy checker", () => {
  it("gives the wrapper registry the compiler's checker only when it is first needed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-checker-"));
    const spy = countRebuilds();
    try {
      const engine = new EventraEngine(root);
      expect(spy.count()).toBe(0);
      const registry = (engine as unknown as { wrapperRegistry: { getChecker(): unknown } }).wrapperRegistry;
      expect(registry.getChecker()).toBeDefined();
      expect(spy.count()).toBe(1);
    } finally {
      spy.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
