import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { collectDependencyNames } from "../../src/cli/projectDependencies";

const roots: string[] = [];

function project(files: Record<string, string | object>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-deps-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("collectDependencyNames", () => {
  it("reads all four dependency fields of the root package.json", async () => {
    const root = project({
      "package.json": {
        dependencies: { a: "1" },
        devDependencies: { b: "1" },
        peerDependencies: { c: "1" },
        optionalDependencies: { d: "1" },
        scripts: { e: "x" },
      },
    });
    expect([...(await collectDependencyNames(root))].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("returns an empty set without a usable package.json", async () => {
    expect((await collectDependencyNames(project({}))).size).toBe(0);
    expect((await collectDependencyNames(project({ "package.json": "{ not json" }))).size).toBe(0);
    expect((await collectDependencyNames(project({ "package.json": "[]" }))).size).toBe(0);
    expect((await collectDependencyNames(project({ "package.json": "null" }))).size).toBe(0);
    expect((await collectDependencyNames(project({ "package.json": "42" }))).size).toBe(0);
  });

  it("ignores dependency fields that are not objects", async () => {
    const root = project({ "package.json": { dependencies: ["x"], devDependencies: "y", peerDependencies: null, optionalDependencies: 3 } });
    expect((await collectDependencyNames(root)).size).toBe(0);
  });

  it("reads workspace members from the `workspaces` array", async () => {
    const root = project({
      "package.json": { workspaces: ["apps/*", "packages/ui/"], dependencies: { root: "1" } },
      "apps/web/package.json": { dependencies: { "posthog-js": "1" } },
      "apps/api/package.json": { devDependencies: { "posthog-node": "1" } },
      "packages/ui/package.json": { dependencies: { "react-ga4": "1" } },
      "apps/web/node_modules/dep/package.json": { dependencies: { hidden: "1" } },
      "other/package.json": { dependencies: { outside: "1" } },
    });
    expect([...(await collectDependencyNames(root))].sort()).toEqual(["posthog-js", "posthog-node", "react-ga4", "root"]);
  });

  it("reads workspace members from `workspaces.packages` (yarn classic form)", async () => {
    const root = project({
      "package.json": { workspaces: { packages: ["libs/*"] } },
      "libs/a/package.json": { dependencies: { "@segment/analytics-next": "1" } },
    });
    expect([...(await collectDependencyNames(root))]).toEqual(["@segment/analytics-next"]);
  });

  it("reads workspace members from pnpm-workspace.yaml, with quotes, comments and negations", async () => {
    const root = project({
      "package.json": { name: "root" },
      "pnpm-workspace.yaml": [
        "# workspace",
        "packages:",
        "  - 'apps/*'   # apps",
        '  - "packages/*"',
        "  - '!packages/skipped'",
        "  - tools/cli",
        "",
        "catalog:",
        "  - not-a-package",
        "onlyBuiltDependencies:",
        "  - esbuild",
      ].join("\n"),
      "apps/web/package.json": { dependencies: { "posthog-js": "1" } },
      "packages/a/package.json": { dependencies: { "amplitude-js": "1" } },
      "packages/skipped/package.json": { dependencies: { skipped: "1" } },
      "tools/cli/package.json": { dependencies: { tool: "1" } },
    });
    expect([...(await collectDependencyNames(root))].sort()).toEqual(["amplitude-js", "posthog-js", "tool"]);
  });

  it("handles a pnpm-workspace.yaml with CRLF line endings and no packages key", async () => {
    const root = project({
      "package.json": { name: "root" },
      "pnpm-workspace.yaml": "other:\r\n  - x\r\n",
      "x/package.json": { dependencies: { nope: "1" } },
    });
    expect((await collectDependencyNames(root)).size).toBe(0);
    const root2 = project({
      "package.json": { name: "root" },
      "pnpm-workspace.yaml": "packages:\r\n  - x\r\n",
      "x/package.json": { dependencies: { yes: "1" } },
    });
    expect([...(await collectDependencyNames(root2))]).toEqual(["yes"]);
  });

  it("skips workspace members with an unreadable package.json and only negated patterns", async () => {
    const root = project({
      "package.json": { workspaces: ["apps/*"] },
      "apps/bad/package.json": "{ nope",
      "apps/good/package.json": { dependencies: { good: "1" } },
    });
    expect([...(await collectDependencyNames(root))]).toEqual(["good"]);
    const onlyNegated = project({ "package.json": { workspaces: ["!apps/*"] }, "apps/a/package.json": { dependencies: { a: "1" } } });
    expect((await collectDependencyNames(onlyNegated)).size).toBe(0);
  });

  it("caps the number of workspace members it reads", async () => {
    const files: Record<string, object> = { "package.json": { workspaces: ["pkgs/*"] } };
    for (let i = 0; i < 305; i++) files[`pkgs/p${i}/package.json`] = { dependencies: { [`dep-${i}`]: "1" } };
    expect((await collectDependencyNames(project(files))).size).toBe(300);
  });

  it("ignores non-string entries and a non-array `workspaces`", async () => {
    const root = project({
      "package.json": { workspaces: ["apps/*", 5, null, { a: 1 }, true] },
      "apps/a/package.json": { dependencies: { a: "1" } },
    });
    expect([...(await collectDependencyNames(root))]).toEqual(["a"]);
    const stringWorkspaces = project({ "package.json": { workspaces: "apps/*" }, "apps/a/package.json": { dependencies: { a: "1" } } });
    expect((await collectDependencyNames(stringWorkspaces)).size).toBe(0);
    const objectNoPackages = project({ "package.json": { workspaces: { nohoist: ["x"] } }, "apps/a/package.json": { dependencies: { a: "1" } } });
    expect((await collectDependencyNames(objectNoPackages)).size).toBe(0);
    const packagesNotList = project({ "package.json": { workspaces: { packages: "apps/*" } }, "apps/a/package.json": { dependencies: { a: "1" } } });
    expect((await collectDependencyNames(packagesNotList)).size).toBe(0);
  });

  it("keeps only string entries of `workspaces`, even when a directory is named like the other values", async () => {
    const root = project({
      "package.json": { workspaces: ["apps/*", 5, null, true, { a: 1 }] },
      "apps/a/package.json": { dependencies: { a: "1" } },
      "5/package.json": { dependencies: { five: "1" } },
      "null/package.json": { dependencies: { nul: "1" } },
      "true/package.json": { dependencies: { tru: "1" } },
      "[object Object]/package.json": { dependencies: { obj: "1" } },
    });
    expect([...(await collectDependencyNames(root))]).toEqual(["a"]);
  });

  it("does not read package.json files outside the project, whatever the pattern says", async () => {
    const parent = project({
      "outside/package.json": { dependencies: { leaked: "1" } },
      "outside/inner/package.json": { dependencies: { leakedInner: "1" } },
      "project/package.json": { workspaces: ["../outside", "../outside/*", "apps/../../outside", "!../outside", "/nonexistent-abs/*"] },
      "project/pnpm-workspace.yaml": "packages:\n  - '../outside'\n  - '../outside/*'\n",
      "project/apps/a/package.json": { dependencies: { inside: "1" } },
    });
    const root = path.join(parent, "project");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["../outside", "../outside/*", "apps/../../outside", "!../outside", "/nonexistent-abs/*", "apps/*"] }));
    expect([...(await collectDependencyNames(root))]).toEqual(["inside"]);
  });

  it("only treats a bare `..` segment as leaving the project, not a directory that merely contains dots and a bang", async () => {
    const root = project({
      "package.json": { workspaces: [".!./*", "a..b/*"] },
      ".!./x/package.json": { dependencies: { bang: "1" } },
      "a..b/y/package.json": { dependencies: { dots: "1" } },
    });
    expect([...(await collectDependencyNames(root))].sort()).toEqual(["bang", "dots"]);
  });

  it("still honours a negated pattern that stays inside the project", async () => {
    const root = project({
      "package.json": { workspaces: ["apps/*", "!apps/skipped", "!/abs/ignored"] },
      "apps/a/package.json": { dependencies: { a: "1" } },
      "apps/skipped/package.json": { dependencies: { skipped: "1" } },
    });
    expect([...(await collectDependencyNames(root))]).toEqual(["a"]);
  });

  it("survives an unreadable pnpm-workspace.yaml (here a directory) and a pattern fast-glob rejects", async () => {
    const root = project({
      "package.json": { workspaces: ["apps/*", "bad\u0000pattern"], dependencies: { rootDep: "1" } },
      "apps/a/package.json": { dependencies: { a: "1" } },
      "pnpm-workspace.yaml/keep": "",
    });
    // The directory named pnpm-workspace.yaml cannot be read as a file; the NUL pattern makes the whole glob fail.
    expect([...(await collectDependencyNames(root))]).toEqual(["rootDep"]);
    const onlyYamlDir = project({
      "package.json": { workspaces: ["apps/*"] },
      "apps/a/package.json": { dependencies: { a: "1" } },
      "pnpm-workspace.yaml/keep": "",
    });
    expect([...(await collectDependencyNames(onlyYamlDir))]).toEqual(["a"]);
  });

  it("never descends into node_modules, even for a recursive pattern", async () => {
    const root = project({
      "package.json": { workspaces: ["apps/**"] },
      "apps/a/package.json": { dependencies: { real: "1" } },
      "apps/a/node_modules/dep/package.json": { dependencies: { hidden: "1" } },
    });
    expect([...(await collectDependencyNames(root))]).toEqual(["real"]);
  });

  it("accepts a trailing slash on both included and excluded patterns", async () => {
    const root = project({
      "package.json": { workspaces: ["apps/*/", "!apps/skipped/"] },
      "apps/a/package.json": { dependencies: { a: "1" } },
      "apps/skipped/package.json": { dependencies: { skipped: "1" } },
    });
    expect([...(await collectDependencyNames(root))]).toEqual(["a"]);
  });

  it("combines `workspaces` and pnpm-workspace.yaml", async () => {
    const root = project({
      "package.json": { workspaces: ["apps/*"] },
      "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
      "apps/a/package.json": { dependencies: { fromWorkspaces: "1" } },
      "libs/b/package.json": { dependencies: { fromPnpm: "1" } },
    });
    expect([...(await collectDependencyNames(root))].sort()).toEqual(["fromPnpm", "fromWorkspaces"]);
  });
});

describe("pnpm-workspace.yaml parsing", () => {
  const members = {
    "package.json": { name: "root" },
    "a/package.json": { dependencies: { a: "1" } },
    "b/package.json": { dependencies: { b: "1" } },
    "c/package.json": { dependencies: { c: "1" } },
    "weird/package.json": { dependencies: { weird: "1" } },
  };
  const read = async (yaml: string) =>
    [...(await collectDependencyNames(project({ ...members, "pnpm-workspace.yaml": yaml })))].sort();

  it("ignores list items that come before the packages key", async () => {
    expect(await read("  - 'c'\npackages:\n  - 'a'\n")).toEqual(["a"]);
  });

  it("only treats an unindented `packages:` as the key, with trailing spaces and long comments allowed", async () => {
    expect(await read("other:\n  packages:\n    - 'a'\n")).toEqual([]);
    expect(await read("packages:   \n  - a\n")).toEqual(["a"]);
    expect(await read("packages: # every workspace package of this repo\n  - a\n")).toEqual(["a"]);
    expect(await read("packages:\t\n  - a\n")).toEqual(["a"]);
  });

  it("does not treat `packages:` followed by other text as the key", async () => {
    expect(await read("packages: ['b']\n  - 'a'\n")).toEqual([]);
    expect(await read("packages:x\n  - 'a'\n")).toEqual([]);
    expect(await read("packagesExtra:\n  - 'a'\n")).toEqual([]);
  });

  it("reads items with any amount of whitespace after the dash, and with or without quotes", async () => {
    expect(await read("packages:\n  -   'a'\n  -\tb\n  - \"c\"\n")).toEqual(["a", "b", "c"]);
  });

  it("reads items whose dashes sit at the key's own indent, as well as indented ones", async () => {
    expect(await read("packages:\n- a\n- 'b'\n")).toEqual(["a", "b"]);
    expect(await read("packages:\n- a\n  - b\n    - c\n")).toEqual(["a", "b", "c"]);
  });

  it("does not read a dash in the middle of a line as an item", async () => {
    expect(await read("packages:\n  - a\nweird - something\n")).toEqual(["a"]);
    expect(await read("packages:\n  - a\n  note about the list - weird\n")).toEqual(["a"]);
  });

  it("stops at the next top-level key, even when it is followed by more list items", async () => {
    expect(await read("packages:\n  - a\ncatalog:\n  - b\nonlyBuiltDependencies:\n  - c\n")).toEqual(["a"]);
  });

  it("keeps reading across blank lines and indented comments", async () => {
    expect(await read("packages:\n  - a\n\n  # a note\n  - b\n")).toEqual(["a", "b"]);
  });

  it("returns nothing when there is no packages key at all", async () => {
    expect(await read("catalog:\n  - a\n")).toEqual([]);
  });
});
