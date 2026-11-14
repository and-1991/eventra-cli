import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { isEventraSdkTrackCall } from "../../src/analysis/sdk/isEventraTrackCall";

// Only the SDK's own `Eventra` counts: the CLI's stand-in `declare module "@eventra_dev/eventra-sdk"`, or the
// declaration files of the installed package (found by the name in its package.json, so a workspace link to the
// SDK works too). A class of the user's that is merely called `Eventra`, or that sits in a folder whose path
// mentions "eventra-sdk", is not the SDK.

const SDK_DTS = `export interface TrackOptions { properties?: Record<string, unknown> }
export declare class Eventra {
  constructor(options: { apiKey: string });
  track(name: string, options?: TrackOptions): void;
}
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Writes `files` under a fresh folder and returns the `.track` calls of `entry`, each with whether it counts. */
function trackCalls(files: Record<string, string>, entry = "app.ts", links: Record<string, string> = {}): boolean[] {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eventraClassOrigin-")));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  for (const [rel, target] of Object.entries(links)) {
    const link = path.join(root, rel);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(root, target), link, "dir");
  }
  const ctx = new CompilerContext(root);
  for (const rel of Object.keys(files).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("node_modules"))) {
    ctx.updateFile(path.join(root, rel), files[rel]);
  }
  const checker = ctx.getChecker();
  const source = ctx.getSourceFile(path.join(root, entry))!;
  const results: boolean[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "track") {
      results.push(isEventraSdkTrackCall(node, checker));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return results;
}

describe("which Eventra class counts as the SDK", () => {
  it("does not count a class of the user's that is called Eventra", () => {
    expect(
      trackCalls({
        "app.ts": `
          class Eventra { track(name: string): void {} }
          const tracker = new Eventra();
          tracker.track("own_class");
          function send(t: Eventra) { t.track("own_class_param"); }
          new Eventra().track("own_class_direct");
        `,
      }),
    ).toEqual([false, false, false]);
  });

  it("does not count a class called Eventra imported from a file of the user's", () => {
    expect(
      trackCalls({
        "lib/tracker.ts": `export class Eventra { track(name: string): void {} }`,
        "app.ts": `
          import { Eventra } from "./lib/tracker";
          const tracker = new Eventra();
          tracker.track("imported_own_class");
        `,
      }),
    ).toEqual([false]);
  });

  it("does not count a class called Eventra in a folder whose path mentions eventra-sdk", () => {
    expect(
      trackCalls({
        "src/eventra-sdk/index.ts": `export class Eventra { track(name: string): void {} }`,
        "node_modules/my-eventra-sdk/package.json": JSON.stringify({ name: "my-eventra-sdk", types: "index.d.ts" }),
        "node_modules/my-eventra-sdk/index.d.ts": SDK_DTS,
        "node_modules/@eventra_dev/other/package.json": JSON.stringify({ name: "@eventra_dev/other", types: "index.d.ts" }),
        "node_modules/@eventra_dev/other/index.d.ts": SDK_DTS,
        "app.ts": `
          import { Eventra as Local } from "./src/eventra-sdk";
          import { Eventra as Lookalike } from "my-eventra-sdk";
          import { Eventra as Other } from "@eventra_dev/other";
          new Local().track("local_folder");
          const a = new Lookalike({ apiKey: "k" });
          a.track("lookalike_package");
          const b = new Other({ apiKey: "k" });
          b.track("other_eventra_package");
        `,
      }),
    ).toEqual([false, false, false]);
  });

  it("does not count a class called Eventra declared in another module's ambient block", () => {
    expect(
      trackCalls({
        "types.d.ts": `declare module "not-the-sdk" { export class Eventra { track(name: string): void } }`,
        "app.ts": `
          /// <reference path="./types.d.ts" />
          import { Eventra } from "not-the-sdk";
          const tracker = new Eventra();
          tracker.track("other_ambient_module");
        `,
      }),
    ).toEqual([false]);
  });

  it("does not count a declaration file outside any package", () => {
    expect(
      trackCalls({
        "vendor/sdk.d.ts": SDK_DTS,
        "app.ts": `
          import { Eventra } from "./vendor/sdk";
          const tracker = new Eventra({ apiKey: "k" });
          tracker.track("loose_declaration_file");
        `,
      }),
    ).toEqual([false]);
  });

  it("counts the CLI's own stand-in for the SDK", () => {
    expect(
      trackCalls({
        "__eventra_sdk_types__.d.ts": EVENTRA_SDK_SHIM,
        "app.ts": `
          /// <reference path="./__eventra_sdk_types__.d.ts" />
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const tracker = new Eventra({ apiKey: "k" });
          tracker.track("shim");
          tracker?.track("shim_optional");
          new Eventra({ apiKey: "k" }).track("shim_direct");
        `,
      }),
    ).toEqual([true, true, true]);
  });

  it("counts the installed SDK package, its declarations found through package.json", () => {
    expect(
      trackCalls({
        "node_modules/@eventra_dev/eventra-sdk/package.json": JSON.stringify({ name: "@eventra_dev/eventra-sdk", types: "dist/index.d.ts" }),
        "node_modules/@eventra_dev/eventra-sdk/dist/index.d.ts": SDK_DTS,
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const tracker = new Eventra({ apiKey: "k" });
          tracker.track("installed");
          function send(t: Eventra) { t.track("installed_param"); }
        `,
      }),
    ).toEqual([true, true]);
  });

  it("counts the SDK's declarations under a nested package.json without a name, and passes over one that cannot be read", () => {
    expect(
      trackCalls({
        "node_modules/@eventra_dev/eventra-sdk/package.json": JSON.stringify({ name: "@eventra_dev/eventra-sdk", types: "dist/cjs/index.d.ts" }),
        "node_modules/@eventra_dev/eventra-sdk/dist/package.json": "{ not json",
        "node_modules/@eventra_dev/eventra-sdk/dist/cjs/package.json": JSON.stringify({ type: "commonjs" }),
        "node_modules/@eventra_dev/eventra-sdk/dist/cjs/index.d.ts": SDK_DTS,
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const tracker = new Eventra({ apiKey: "k" });
          tracker.track("nested_package_json");
        `,
      }),
    ).toEqual([true]);
  });

  it("counts the SDK linked into node_modules from a workspace folder", () => {
    expect(
      trackCalls(
        {
          "packages/sdk/package.json": JSON.stringify({ name: "@eventra_dev/eventra-sdk", types: "dist/index.d.ts" }),
          "packages/sdk/dist/index.d.ts": SDK_DTS,
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const tracker = new Eventra({ apiKey: "k" });
            tracker.track("workspace_link");
          `,
        },
        "app.ts",
        { "node_modules/@eventra_dev/eventra-sdk": "packages/sdk" },
      ),
    ).toEqual([true]);
  });
});
