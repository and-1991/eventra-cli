import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CompilerContext } from "../../src/compiler/compilerContext";

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
});
