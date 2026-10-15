import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { findWorkspacePackages } from "../../src/compiler/workspacePackages";

function tree(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-mono-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root, at: (rel: string) => path.join(root, rel), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const rel = (root: string, file: string | undefined) => (file ? path.relative(root, file).replace(/\\/g, "/") : undefined);
const tsconfig = (compilerOptions: object) => JSON.stringify({ compilerOptions });

describe("imports resolve against the nearest tsconfig.json", () => {
  it("gives each app its own `@/*` when the repository has no root tsconfig", () => {
    const t = tree({
      "apps/a/tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@/*": ["./src/*"] } }),
      "apps/a/src/util.ts": "export const a = 1;",
      "apps/a/src/page.ts": "",
      "apps/b/tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@/*": ["./lib/*"] } }),
      "apps/b/lib/util.ts": "export const b = 1;",
      "apps/b/lib/page.ts": "",
    });
    try {
      const ctx = new CompilerContext(t.root);
      expect(rel(t.root, ctx.resolveModule("@/util", t.at("apps/a/src/page.ts")))).toBe("apps/a/src/util.ts");
      expect(rel(t.root, ctx.resolveModule("@/util", t.at("apps/b/lib/page.ts")))).toBe("apps/b/lib/util.ts");
    } finally {
      t.cleanup();
    }
  });

  it("uses the closest config for a deeply nested file, and its own paths instead of the root's", () => {
    const t = tree({
      "tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@root/*": ["./shared/*"] } }),
      "shared/s.ts": "export const s = 1;",
      "apps/web/tsconfig.json": tsconfig({ baseUrl: ".", paths: { "~/*": ["./app/*"] } }),
      "apps/web/app/deep/er/file.ts": "",
      "apps/web/app/m.ts": "export const m = 1;",
      "top.ts": "",
    });
    try {
      const ctx = new CompilerContext(t.root);
      const deep = t.at("apps/web/app/deep/er/file.ts");
      expect(rel(t.root, ctx.resolveModule("~/m", deep))).toBe("apps/web/app/m.ts");
      // the nested config replaced the root's `paths`, it did not add to them
      expect(ctx.resolveModule("@root/s", deep)).toBeUndefined();
      // a file outside any nested config still gets the root's
      expect(rel(t.root, ctx.resolveModule("@root/s", t.at("top.ts")))).toBe("shared/s.ts");
    } finally {
      t.cleanup();
    }
  });

  it("falls back to the root options for a file outside the project", () => {
    const t = tree({ "tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@r/*": ["./r/*"] } }), "r/x.ts": "export {};" });
    const outside = tree({ "elsewhere.ts": "" });
    try {
      const ctx = new CompilerContext(t.root);
      expect(rel(t.root, ctx.resolveModule("@r/x", outside.at("elsewhere.ts")))).toBe("r/x.ts");
    } finally {
      t.cleanup();
      outside.cleanup();
    }
  });

  it("ignores a nested tsconfig that cannot be read, and lets one that sets no paths keep the root's aliases", () => {
    const t = tree({
      "tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@r/*": ["./r/*"] } }),
      "r/x.ts": "export {};",
      "broken/tsconfig.json": "{ nope",
      "broken/f.ts": "",
      "plain/tsconfig.json": tsconfig({ strict: true }),
      "plain/f.ts": "",
    });
    try {
      const ctx = new CompilerContext(t.root);
      expect(rel(t.root, ctx.resolveModule("@r/x", t.at("broken/f.ts")))).toBe("r/x.ts");
      // a config that only adjusts a few options does not take the root's aliases away from its folder
      expect(rel(t.root, ctx.resolveModule("@r/x", t.at("plain/f.ts")))).toBe("r/x.ts");
    } finally {
      t.cleanup();
    }
  });

  it("keeps the root's baseUrl unless the nested config sets its own, when it sets no paths", () => {
    const t = tree({
      "tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@r/*": ["./r/*"] } }),
      "r/x.ts": "export {};",
      "own/tsconfig.json": tsconfig({ baseUrl: "." }),
      "own/f.ts": "",
      "own/local.ts": "export {};",
    });
    try {
      const ctx = new CompilerContext(t.root);
      // the nested baseUrl (its own folder) wins, so the root's `./r/*` is looked up under `own/`, where it is not
      expect(ctx.resolveModule("@r/x", t.at("own/f.ts"))).toBeUndefined();
      expect(rel(t.root, ctx.resolveModule("local", t.at("own/f.ts")))).toBe("own/local.ts");
    } finally {
      t.cleanup();
    }
  });

  it("does not apply the tsconfig.json of an installed package to that package's imports", () => {
    const t = tree({
      "tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@r/*": ["./r/*"] } }),
      "r/x.ts": "export {};",
      "node_modules/pkg/tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@other/*": ["./nope/*"] } }),
      "node_modules/pkg/index.ts": "",
    });
    try {
      const ctx = new CompilerContext(t.root);
      expect(rel(t.root, ctx.resolveModule("@r/x", t.at("node_modules/pkg/index.ts")))).toBe("r/x.ts");
    } finally {
      t.cleanup();
    }
  });

  it("sees an edited nested tsconfig.json after the next build", () => {
    const t = tree({
      "app/tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@/*": ["./one/*"] } }),
      "app/one/u.ts": "export {};",
      "app/two/u.ts": "export {};",
      "app/main.ts": "",
    });
    try {
      const ctx = new CompilerContext(t.root);
      expect(rel(t.root, ctx.resolveModule("@/u", t.at("app/main.ts")))).toBe("app/one/u.ts");
      fs.writeFileSync(t.at("app/tsconfig.json"), tsconfig({ baseUrl: ".", paths: { "@/*": ["./two/*"] } }));
      ctx.stageFile(t.at("app/main.ts"), "");
      ctx.flushUpdates();
      expect(rel(t.root, ctx.resolveModule("@/u", t.at("app/main.ts")))).toBe("app/two/u.ts");
    } finally {
      t.cleanup();
    }
  });

  it("keeps sharing the resolution caches when a program is built inside a batch, and drops them after it", () => {
    const t = tree({ "tsconfig.json": tsconfig({}), "a.ts": "export {};" });
    try {
      const ctx = new CompilerContext(t.root);
      const inner = ctx as unknown as { cachingDepth: number; resolutionCaches: Map<unknown, unknown> };
      ctx.stageFile(t.at("a.ts"), "export {};");
      ctx.withResolutionCache(() => {
        ctx.flushUpdates(); // a build starting inside the batch
        expect(inner.cachingDepth).toBe(1);
        ctx.resolveModule("./a", t.at("a.ts"));
        expect(inner.resolutionCaches.size).toBeGreaterThan(0);
      });
      expect(inner.cachingDepth).toBe(0);
      expect(inner.resolutionCaches.size).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it("reads aliases from a project reference in a nested solution-style config", () => {
    const t = tree({
      "app/tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
      "app/tsconfig.app.json": JSON.stringify({ compilerOptions: { composite: true, paths: { "@/*": ["./src/*"] } } }),
      "app/src/u.ts": "export {};",
      "app/main.ts": "",
    });
    try {
      expect(rel(t.root, new CompilerContext(t.root).resolveModule("@/u", t.at("app/main.ts")))).toBe("app/src/u.ts");
    } finally {
      t.cleanup();
    }
  });

  it("sees a file that appears after the first lookup (nothing is cached between builds)", () => {
    const t = tree({ "tsconfig.json": tsconfig({}), "a.ts": "" });
    try {
      const ctx = new CompilerContext(t.root);
      expect(ctx.resolveModule("./late", t.at("a.ts"))).toBeUndefined();
      ctx.stageFile(t.at("late.ts"), "export {};");
      ctx.flushUpdates();
      expect(rel(t.root, ctx.resolveModule("./late", t.at("a.ts")))).toBe("late.ts");
    } finally {
      t.cleanup();
    }
  });

  it("resolves imports of a program built from several configs, through the program itself", () => {
    const t = tree({
      "apps/a/tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@/*": ["./src/*"] } }),
      "apps/a/src/util.ts": "export const a = 1;",
      "apps/a/src/page.ts": `import { a } from "@/util"; export const x = a;`,
    });
    try {
      const ctx = new CompilerContext(t.root);
      ctx.stageFile(t.at("apps/a/src/page.ts"), fs.readFileSync(t.at("apps/a/src/page.ts"), "utf8"));
      ctx.flushUpdates();
      expect(ctx.getResolvedModules(t.at("apps/a/src/page.ts")).map((f) => rel(t.root, f))).toEqual(["apps/a/src/util.ts"]);
    } finally {
      t.cleanup();
    }
  });
});

describe("packages of the monorepo resolve without being installed", () => {
  const pkg = (name: string, extra: object = {}) => JSON.stringify({ name, ...extra });

  it("finds a package by name, with a subpath, and falls back to its src folder", () => {
    const t = tree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/lib/package.json": pkg("@acme/lib", { main: "dist/index.js" }),
      "packages/lib/hooks/use-x.ts": "export const x = 1;",
      "packages/lib/src/index.ts": "export const lib = 1;",
      "packages/lib/src/extra/e.ts": "export const e = 1;",
      "apps/web/main.ts": "",
    });
    try {
      const ctx = new CompilerContext(t.root);
      const from = t.at("apps/web/main.ts");
      expect(rel(t.root, ctx.resolveModule("@acme/lib/hooks/use-x", from))).toBe("packages/lib/hooks/use-x.ts");
      expect(rel(t.root, ctx.resolveModule("@acme/lib", from))).toBe("packages/lib/src/index.ts");
      expect(rel(t.root, ctx.resolveModule("@acme/lib/extra/e", from))).toBe("packages/lib/src/extra/e.ts");
      expect(ctx.resolveModule("@acme/lib/missing", from)).toBeUndefined();
      expect(ctx.resolveModule("@acme/other", from)).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  it("works with a pnpm-workspace.yaml and with the object form of `workspaces`", () => {
    const yaml = tree({
      "package.json": "{}",
      "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
      "libs/a/package.json": pkg("a-lib"),
      "libs/a/index.ts": "export {};",
      "main.ts": "",
    });
    const object = tree({
      "package.json": JSON.stringify({ workspaces: { packages: ["libs/*"] } }),
      "libs/b/package.json": pkg("b-lib"),
      "libs/b/index.ts": "export {};",
      "main.ts": "",
    });
    try {
      expect(rel(yaml.root, new CompilerContext(yaml.root).resolveModule("a-lib", yaml.at("main.ts")))).toBe("libs/a/index.ts");
      expect(rel(object.root, new CompilerContext(object.root).resolveModule("b-lib", object.at("main.ts")))).toBe("libs/b/index.ts");
    } finally {
      yaml.cleanup();
      object.cleanup();
    }
  });

  it("prefers the longest matching package name", () => {
    const t = tree({
      "package.json": JSON.stringify({ workspaces: ["p/*"] }),
      "p/outer/package.json": pkg("pkg"),
      "p/outer/inner/index.ts": "export const outer = 1;",
      "p/inner/package.json": pkg("pkg/inner"),
      "p/inner/index.ts": "export const inner = 1;",
      "main.ts": "",
    });
    try {
      expect(rel(t.root, new CompilerContext(t.root).resolveModule("pkg/inner", t.at("main.ts")))).toBe("p/inner/index.ts");
    } finally {
      t.cleanup();
    }
  });

  it("prefers a real node_modules install over the workspace folder", () => {
    const t = tree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/lib/package.json": pkg("@acme/lib"),
      "packages/lib/index.ts": "export const fromFolder = 1;",
      "node_modules/@acme/lib/package.json": pkg("@acme/lib", { types: "index.d.ts" }),
      "node_modules/@acme/lib/index.d.ts": "export declare const fromInstall: number;",
      "main.ts": "",
    });
    try {
      expect(rel(t.root, new CompilerContext(t.root).resolveModule("@acme/lib", t.at("main.ts")))).toBe("node_modules/@acme/lib/index.d.ts");
    } finally {
      t.cleanup();
    }
  });
});

describe("findWorkspacePackages", () => {
  const names = (root: string) => [...findWorkspacePackages(root).keys()].sort();

  it("is empty without a package.json, with a broken one, or with no workspaces", () => {
    const none = tree({ "x.txt": "" });
    const broken = tree({ "package.json": "{ nope" });
    const plain = tree({ "package.json": JSON.stringify({ name: "solo" }) });
    try {
      expect(names(none.root)).toEqual([]);
      expect(names(broken.root)).toEqual([]);
      expect(names(plain.root)).toEqual([]);
    } finally {
      none.cleanup();
      broken.cleanup();
      plain.cleanup();
    }
  });

  it("skips members without a name, repeats of a name, and patterns that leave the project", () => {
    const t = tree({
      "package.json": JSON.stringify({ workspaces: ["pk/*", "../outside/*", "/abs/*"] }),
      "pk/a/package.json": JSON.stringify({ name: "same" }),
      "pk/b/package.json": JSON.stringify({ name: "same" }),
      "pk/c/package.json": JSON.stringify({ version: "1" }),
      "pk/d/package.json": JSON.stringify({ name: "" }),
      "pk/e/package.json": "{ nope",
      "pk/f/package.json": JSON.stringify({ name: "other" }),
    });
    try {
      expect(names(t.root)).toEqual(["other", "same"]);
      expect(findWorkspacePackages(t.root).get("same")).toBe(t.at("pk/a"));
    } finally {
      t.cleanup();
    }
  });

  it("copes with a pnpm-workspace.yaml that is a directory, and with a pattern fast-glob rejects", () => {
    const dirYaml = tree({ "package.json": JSON.stringify({ workspaces: ["pk/*"] }), "pnpm-workspace.yaml/keep": "", "pk/a/package.json": JSON.stringify({ name: "a" }) });
    const bad = tree({ "package.json": JSON.stringify({ workspaces: ["pa\u0000ck/*"] }) });
    try {
      expect(names(dirYaml.root)).toEqual(["a"]);
      expect(names(bad.root)).toEqual([]);
    } finally {
      dirYaml.cleanup();
      bad.cleanup();
    }
  });
});
