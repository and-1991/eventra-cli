import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { normalizeConfig } from "../../src/config/config";
import { createPluginRegistry } from "../../src/plugin/loadPlugins";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";
const CONFIG = normalizeConfig({ sinks: [{ preset: "posthog" }] });

async function eventsOf(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-hooks-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const engine = new EventraEngine(root, await createPluginRegistry(CONFIG));
    engine.beginPreload();
    await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
    const names: string[] = [SDK_TYPES];
    for (const [rel, content] of Object.entries(files)) {
      if (!/\.tsx?$/.test(rel)) continue;
      const abs = path.join(root, rel);
      await engine.preloadFile(abs, content);
      names.push(abs);
    }
    engine.endPreload();
    await engine.runFullAnalysis(names, CONFIG);
    return engine.getAllEvents();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("a hook that hands back the functions it defined", () => {
  it("follows `return { capture }` to the arrow function declared next to it", async () => {
    expect(
      await eventsOf({
        "hook.ts": `import ph from "posthog-js";
          export function useAnalytics() {
            const capture = (event: string, props?: object) => { ph.capture(event, props); };
            return { capture };
          }`,
        "use.ts": `import { useAnalytics } from "./hook";
          const analytics = useAnalytics();
          analytics.capture("hook:shorthand");`,
      }),
    ).toEqual(["hook:shorthand"]);
  });

  it("follows `return { track: capture }` and a function declaration", async () => {
    expect(
      await eventsOf({
        "hook.ts": `import ph from "posthog-js";
          export function useAnalytics() {
            function capture(event: string) { ph.capture(event); }
            return { track: capture };
          }`,
        "use.ts": `import { useAnalytics } from "./hook"; useAnalytics().track("hook:renamed");`,
      }),
    ).toEqual(["hook:renamed"]);
  });
});

describe("a returned member that is not a function it defined", () => {
  it("resolves nothing for `return { track }` when `track` is only a parameter", async () => {
    expect(
      await eventsOf({
        "hook.ts": `export function make(track: (name: string) => void) { return { track }; }`,
        "use.ts": `import { make } from "./hook"; make(() => {}).track("hook:not_defined_here");`,
      }),
    ).toEqual([]);
  });
});

describe("posthog-js loaded with a dynamic import", () => {
  const CALL = `export const f = (e: string) => track(e);`;

  it("reads `const { default: client } = await import(...)`", async () => {
    expect(
      await eventsOf({
        "a.ts": `export async function f() { const { default: client } = await import("posthog-js"); client.capture("dyn:await_destructure"); }`,
      }),
    ).toEqual(["dyn:await_destructure"]);
  });

  it("reads `(await import(...)).default.capture(...)`", async () => {
    expect(
      await eventsOf({
        "a.ts": `export async function f() { (await import("posthog-js")).default.capture("dyn:await_default"); }`,
      }),
    ).toEqual(["dyn:await_default"]);
  });

  it("reads `import(...).then(({ default: client }) => ...)`", async () => {
    expect(
      await eventsOf({
        "a.ts": `export function f() { import("posthog-js").then(({ default: client }) => { client.capture("dyn:then_destructure"); }); }`,
      }),
    ).toEqual(["dyn:then_destructure"]);
  });

  it("reads `import(...).then((mod) => mod.default.capture(...))`", async () => {
    expect(
      await eventsOf({
        "a.ts": `export function f() { import("posthog-js").then((mod) => mod.default.capture("dyn:then_module")); }`,
      }),
    ).toEqual(["dyn:then_module"]);
  });

  it("reads a promise kept in a variable, through a getter function", async () => {
    expect(
      await eventsOf({
        "a.ts": `let promise: Promise<typeof import("posthog-js")> | null = null;
          const load = async () => { if (!promise) promise = import("posthog-js"); return promise; };
          export function f() { void load().then(({ default: client }) => { client.capture("dyn:getter"); }); }`,
      }),
    ).toEqual(["dyn:getter"]);
  });

  it("reads a function whose return annotation names the module", async () => {
    expect(
      await eventsOf({
        "a.ts": `declare function loadIt(): Promise<typeof import("posthog-js")>;
          export function f() { loadIt().then(({ default: client }) => client.capture("dyn:annotated")); }`,
      }),
    ).toEqual(["dyn:annotated"]);
  });

  it("reads `typeof client`, but not any generic that merely mentions the module", async () => {
    expect(
      await eventsOf({
        "a.ts": `import ph from "posthog-js";
          declare let client: typeof ph | undefined;
          declare let list: Array<typeof ph>;
          export function f() { client?.capture("dyn:typeof"); list.capture("dyn:array_of"); }`,
      }),
    ).toEqual(["dyn:typeof"]);
  });

  it("does not trust a promise of something else, or a callback that is not .then()", async () => {
    expect(
      await eventsOf({
        "a.ts": `export function f() {
            import("other-lib").then(({ default: client }) => { client.capture("dyn:other_module"); });
            [1].map(({ toFixed: client }: any) => { client.capture("dyn:not_then"); });
            Promise.resolve(1).then((a: any, b: any) => a.capture("dyn:second_arg_only"));
            ((x: any) => x.capture("dyn:iife"))({});
          }`,
      }),
    ).toEqual([]);
  });

  it("does not trust a type that imports another module, nor one that is not a module name", async () => {
    expect(
      await eventsOf({
        "a.ts": `declare let a: typeof import("other-lib");
          // @ts-expect-error not a valid import type, only here to see that it is not read as one
          declare let b: typeof import(true);
          export function f() { a.capture("dyn:other_type"); b.capture("dyn:literal_type"); }`,
      }),
    ).toEqual([]);
  });

  it("ignores a function that does not return the module", async () => {
    expect(
      await eventsOf({
        "a.ts": `function other() { return 1; }
          export function f() { other().then((x: any) => x.capture("dyn:unrelated")); }`,
      }),
    ).toEqual([]);
  });
});
