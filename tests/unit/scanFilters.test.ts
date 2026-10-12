import { describe, expect, it } from "vitest";

import { createFileFilter, expandExcludePatterns, globToRegExp } from "../../src/core/scanFilters";

describe("expandExcludePatterns", () => {
  it("expands plain names so they match at any depth", () => {
    expect(expandExcludePatterns(["node_modules", "dist"])).toEqual([
      "**/node_modules",
      "**/node_modules/**",
      "**/dist",
      "**/dist/**",
    ]);
  });

  it("keeps entries that contain a slash or glob characters exactly as written", () => {
    expect(expandExcludePatterns(["src/legacy", "**/*.spec.ts", "build/", "gen?"])).toEqual([
      "src/legacy",
      "**/*.spec.ts",
      "build/",
      "gen?",
    ]);
  });

  it("drops blank entries and duplicates", () => {
    expect(expandExcludePatterns(["", "  ", "dist", "dist"])).toEqual(["**/dist", "**/dist/**"]);
  });
});

describe("globToRegExp", () => {
  const m = (glob: string, file: string) => globToRegExp(glob).test(file);

  it("matches the default include pattern", () => {
    expect(m("**/*.{ts,tsx,js,jsx}", "a.ts")).toBe(true);
    expect(m("**/*.{ts,tsx,js,jsx}", "src/deep/a.tsx")).toBe(true);
    expect(m("**/*.{ts,tsx,js,jsx}", "src/a.vue")).toBe(false);
    expect(m("**/*.{ts,tsx,js,jsx}", "src/a.tsx.map")).toBe(false);
  });

  it("treats * as one path segment and ** as any depth", () => {
    expect(m("src/*.ts", "src/a.ts")).toBe(true);
    expect(m("src/*.ts", "src/x/a.ts")).toBe(false);
    expect(m("src/**", "src/x/y/a.ts")).toBe(true);
    expect(m("**/*.vue", "a.vue")).toBe(true);
  });

  it("supports ?, character classes, nested braces and a leading ./", () => {
    expect(m("a?.ts", "ab.ts")).toBe(true);
    expect(m("a?.ts", "a/.ts")).toBe(false);
    expect(m("file[0-9].ts", "file7.ts")).toBe(true);
    expect(m("{a,b{1,2}}.ts", "b2.ts")).toBe(true);
    expect(m("./src/a.ts", "src/a.ts")).toBe(true);
  });

  it("never lets *, ** or ? match a hidden segment unless the glob spells the dot (like fast-glob)", () => {
    expect(m("**/*.ts", ".svelte-kit/output/a.ts")).toBe(false);
    expect(m("**/*.ts", "src/.nuxt/a.ts")).toBe(false);
    expect(m("**/*.ts", "src/.hidden.ts")).toBe(false);
    expect(m("src/**", "src/.turbo/x.ts")).toBe(false);
    expect(m("src/*", "src/.env")).toBe(false);
    expect(m("src/?env", "src/.env")).toBe(false);
    expect(m("**", ".vercel/output/x.js")).toBe(false);
    expect(m("**", "a/b/c.js")).toBe(true);
    expect(m("**/{a,b}.ts", ".x/a.ts")).toBe(false);
    // spelled dots do match
    expect(m(".github/**", ".github/workflows/ci.yml")).toBe(true);
    expect(m("**/.storybook/*.ts", "app/.storybook/main.ts")).toBe(true);
    expect(m("src/.*", "src/.env")).toBe(true);
  });

  it("keeps ** as any text when it is not a whole path segment", () => {
    expect(m("a**b.ts", "aXYb.ts")).toBe(true);
    expect(m("a**b.ts", "a/x/b.ts")).toBe(true);
  });

  it("escapes regex metacharacters and tolerates an unclosed [", () => {
    expect(m("a.b.ts", "a.b.ts")).toBe(true);
    expect(m("a.b.ts", "axb.ts")).toBe(false);
    expect(m("a+(b).ts", "a+(b).ts")).toBe(true);
    expect(m("a[b.ts", "a[b.ts")).toBe(true);
  });
});

describe("createFileFilter", () => {
  const cwd = "/proj";
  const filter = createFileFilter(
    ["**/*.{ts,vue}", "!**/*.d.ts"],
    ["node_modules", "dist", "src/legacy", "**/*.spec.ts"],
    cwd,
    ["eventra.json"],
  );

  it("includes matching files and rejects other extensions", () => {
    expect(filter.isIncluded("/proj/src/a.ts")).toBe(true);
    expect(filter.isIncluded("/proj/src/a.vue")).toBe(true);
    expect(filter.isIncluded("/proj/README.md")).toBe(false);
  });

  it("excludes plain names at any depth, which is what sync does too", () => {
    expect(filter.isExcluded("/proj/node_modules/x/a.ts")).toBe(true);
    expect(filter.isExcluded("/proj/packages/web/node_modules/x/a.ts")).toBe(true);
    expect(filter.isExcluded("/proj/packages/web/dist/a.ts")).toBe(true);
    expect(filter.isIncluded("/proj/packages/web/dist/a.ts")).toBe(false);
  });

  it("excludes path entries, globs and everything under an excluded directory", () => {
    expect(filter.isExcluded("/proj/src/legacy")).toBe(true);
    expect(filter.isExcluded("/proj/src/legacy/old.ts")).toBe(true);
    expect(filter.isExcluded("/proj/src/legacy2/old.ts")).toBe(false);
    expect(filter.isExcluded("/proj/src/a.spec.ts")).toBe(true);
  });

  it("applies negated include patterns", () => {
    expect(filter.isIncluded("/proj/src/types.d.ts")).toBe(false);
  });

  it("never treats the always-excluded files (eventra.json) as handled", () => {
    expect(filter.isExcluded("/proj/eventra.json")).toBe(true);
    expect(filter.isExcluded("/proj/sub/eventra.json")).toBe(false);
  });

  it("does not match the parent directory names of the project itself", () => {
    const inDist = createFileFilter(["**/*.ts"], ["dist"], "/home/u/dist/proj");
    expect(inDist.isIncluded("/home/u/dist/proj/src/a.ts")).toBe(true);
  });

  it("rejects files outside the project root", () => {
    expect(filter.isIncluded("/elsewhere/a.ts")).toBe(false);
  });
});
