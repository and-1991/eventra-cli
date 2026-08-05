import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";
import { CompilerContext } from "../../src/compiler/compilerContext";

// CompilerContext keeps its ts.CompilerHost private; some plumbing hooks (the
// disk-fallback path in the patched getSourceFile, the raw-ScriptTarget
// overload, getNewLine) are only reachable by calling the real host directly,
// the same way an external ts.CompilerHost consumer would.
function getHost(ctx: CompilerContext): ts.CompilerHost {
  return (ctx as unknown as { host: ts.CompilerHost }).host;
}

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compilerctx-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe("CompilerContext", () => {
  it("stage + flushUpdates registers the file in the program", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");

      ctx.stageFile(file, "export const a = 1;");
      ctx.flushUpdates();

      expect(ctx.getSourceFile(file)).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("updateFile replaces content and rebuilds the program", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");

      ctx.updateFile(file, "export const a = 1;");
      const first = ctx.getSourceFile(file);
      expect(first?.getText()).toContain("a = 1");

      ctx.updateFile(file, "export const a = 2;");
      const second = ctx.getSourceFile(file);
      expect(second?.getText()).toContain("a = 2");
    } finally {
      cleanup();
    }
  });

  it("removeFile drops the file from the program", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");

      ctx.updateFile(file, "export const a = 1;");
      expect(ctx.getSourceFile(file)).toBeDefined();

      ctx.removeFile(file);
      expect(ctx.getSourceFile(file)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("resolveModule respects tsconfig path aliases", () => {
    const { root, cleanup } = makeProject();
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(
        path.join(root, "src/tracker.ts"),
        "export const trackFeature = () => {};",
      );
      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            baseUrl: ".",
            paths: { "@app/*": ["./src/*"] },
            allowJs: true,
            esModuleInterop: true,
            skipLibCheck: true,
          },
          include: ["src"],
        }),
      );

      const ctx = new CompilerContext(root);
      const callerPath = path.join(root, "app.ts");
      ctx.updateFile(callerPath, `import { trackFeature } from "@app/tracker";`);

      const resolved = ctx.resolveModule("@app/tracker", callerPath);
      expect(resolved).toBeDefined();
      expect(resolved!.replace(/\\/g, "/")).toContain("/src/tracker.ts");
    } finally {
      cleanup();
    }
  });

  it("getAllSourceFiles excludes declaration files", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      ctx.updateFile(path.join(root, "a.ts"), "export const a = 1;");
      ctx.updateFile(path.join(root, "b.ts"), "export const b = 2;");

      const files = ctx.getAllSourceFiles();
      const names = files.map((f) => f.fileName);
      expect(names.some((n) => n.endsWith("a.ts"))).toBe(true);
      expect(names.some((n) => n.endsWith("b.ts"))).toBe(true);
      expect(files.every((f) => !f.isDeclarationFile)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("getChecker returns a working TypeChecker", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      ctx.updateFile(path.join(root, "a.ts"), "export const a = 1;");
      const checker = ctx.getChecker();
      expect(typeof checker.getTypeAtLocation).toBe("function");
    } finally {
      cleanup();
    }
  });

  it("getProgram returns the live ts.Program", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const program = ctx.getProgram();
      expect(typeof program.getTypeChecker).toBe("function");
    } finally {
      cleanup();
    }
  });

  it("throws when the local tsconfig.json is malformed", () => {
    const { root, cleanup } = makeProject();
    try {
      fs.writeFileSync(path.join(root, "tsconfig.json"), "{ this is not json");
      expect(() => new CompilerContext(root)).toThrow();
    } finally {
      cleanup();
    }
  });

  it("assigns ts.ScriptKind based on file extension, including non-.ts extensions", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const cases: Array<[string, string, ts.ScriptKind | undefined]> = [
        ["a.tsx", "export const A = () => null;", ts.ScriptKind.TSX],
        ["b.jsx", "export const B = () => null;", ts.ScriptKind.JSX],
        ["c.js", "module.exports.c = 1;", ts.ScriptKind.JS],
        ["d.json", '{"ok":true}', ts.ScriptKind.JSON],
        // getScriptKind() returns Unknown for an unrecognized extension, but ts's
        // own ts.createSourceFile treats an explicit Unknown as "unspecified" and
        // falls back to inferring TS for it — asserting that here would be
        // pinning ts's internal behavior rather than this file's own logic, so
        // we only check that the fallback path doesn't throw and still parses.
        ["e.txt", "not really code", undefined],
      ];
      for (const [name, content, kind] of cases) {
        const file = path.join(root, name);
        ctx.updateFile(file, content);
        const sourceFile = ctx.getSourceFile(file);
        expect(sourceFile).toBeDefined();
        if (kind !== undefined) {
          expect(sourceFile?.scriptKind).toBe(kind);
        }
      }
    } finally {
      cleanup();
    }
  });

  it("resolveLanguageVersion accepts a raw ts.ScriptTarget (not wrapped in CreateSourceFileOptions)", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(file, "export const a = 1;");

      // The public ts.CompilerHost#getSourceFile contract allows either a bare
      // ts.ScriptTarget or a CreateSourceFileOptions object as the second
      // argument; every call made by ts.Program itself uses the options-object
      // form, so the bare-target branch is only exercised by calling the host
      // directly, exactly as an external consumer of the CompilerHost API could.
      const host = getHost(ctx);
      const sourceFile = host.getSourceFile(file, ts.ScriptTarget.ES2015, undefined, false);
      expect(sourceFile).toBeDefined();
      expect(sourceFile!.getFullText()).toContain("a = 1");
    } finally {
      cleanup();
    }
  });

  it("host.getSourceFile falls back to disk when the registry has no entry for the requested file", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const missing = path.join(root, "missing.ts");
      const host = getHost(ctx);

      // Never staged and never written to disk: registry.ensure() fails to
      // read it (ENOENT, swallowed), so createSourceFileFromRegistry returns
      // undefined and the patched getSourceFile falls through to the
      // disk-backed original implementation.
      let onErrorMessage: string | undefined;
      const sourceFile = host.getSourceFile(
        missing,
        ts.ScriptTarget.ESNext,
        (message) => {
          onErrorMessage = message;
        },
        false,
      );

      // ts's own default getSourceFile never returns undefined when the
      // underlying readFile call throws (rather than returning undefined) —
      // it reports the error via onError and still hands back an (empty)
      // SourceFile, which is what host.readFile does here (fs.readFileSync
      // throws instead of resolving to undefined).
      expect(onErrorMessage).toBeDefined();
      expect(sourceFile).toBeDefined();
      expect(sourceFile!.fileName.replace(/\\/g, "/")).toBe(missing.replace(/\\/g, "/"));
    } finally {
      cleanup();
    }
  });

  it("host.getNewLine reports \\n (consulted by external formatters like ts.formatDiagnostics)", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const host = getHost(ctx);
      // Never invoked by CompilerContext's own methods (noEmit, no pretty
      // printing), but part of the public ts.CompilerHost contract — e.g.
      // ts.formatDiagnostics(diagnostics, host) calls it.
      expect(host.getNewLine()).toBe("\n");
    } finally {
      cleanup();
    }
  });

  describe("getSemanticDiagnostics", () => {
    it("returns pre-emit diagnostics for the whole program when no fileName is given", () => {
      const { root, cleanup } = makeProject();
      try {
        const ctx = new CompilerContext(root);
        ctx.updateFile(path.join(root, "bad.ts"), 'const n: number = "not a number";');

        const diagnostics = ctx.getSemanticDiagnostics();
        expect(diagnostics.length).toBeGreaterThan(0);
      } finally {
        cleanup();
      }
    });

    it("returns [] when the requested file isn't in the program", () => {
      const { root, cleanup } = makeProject();
      try {
        const ctx = new CompilerContext(root);
        expect(ctx.getSemanticDiagnostics(path.join(root, "nope.ts"))).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it("returns semantic + syntactic diagnostics scoped to a single file", () => {
      const { root, cleanup } = makeProject();
      try {
        const ctx = new CompilerContext(root);
        const file = path.join(root, "bad.ts");
        ctx.updateFile(file, 'const n: number = "not a number";');

        const diagnostics = ctx.getSemanticDiagnostics(file);
        expect(diagnostics.length).toBeGreaterThan(0);
      } finally {
        cleanup();
      }
    });
  });

  describe("getResolvedModules", () => {
    it("returns [] when the requested file isn't in the program", () => {
      const { root, cleanup } = makeProject();
      try {
        const ctx = new CompilerContext(root);
        expect(ctx.getResolvedModules(path.join(root, "nope.ts"))).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it("collects resolved import/export targets, skipping non-import statements, bare exports, and unresolvable specifiers", () => {
      const { root, cleanup } = makeProject();
      try {
        const ctx = new CompilerContext(root);
        const dep = path.join(root, "dep.ts");
        ctx.updateFile(dep, "export const dep = 1;");

        const file = path.join(root, "app.ts");
        ctx.updateFile(
          file,
          [
            "const local = 1;", // not an import/export declaration -> continue
            'import { dep } from "./dep";', // resolvable -> added
            'export * from "./dep";', // resolvable export declaration -> added (dedup via Set)
            "export { local };", // export with no module specifier -> continue
            'import { nothing } from "./does-not-exist";', // unresolvable -> not added
            "void local;",
          ].join("\n"),
        );

        const modules = ctx.getResolvedModules(file);
        expect(modules).toHaveLength(1);
        expect(modules[0]!.replace(/\\/g, "/")).toContain("/dep.ts");
      } finally {
        cleanup();
      }
    });
  });
});
