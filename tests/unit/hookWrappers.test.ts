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

describe("a hook that returns a bare function", () => {
  const SDK = `import { Eventra } from "@eventra_dev/eventra-sdk"; const t = new Eventra({ apiKey: "x" });`;

  it("follows `const track = useTracker(); track(...)`", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          export function useTracker() { return (n: string) => t.track(n); }
          const track = useTracker();
          track("hook2_event");`,
      }),
    ).toEqual(["hook2_event"]);
  });

  it("follows an inline `useTracker()(...)`", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          export function useTracker() { return (n: string) => t.track(n); }
          useTracker()("hook2_inline");`,
      }),
    ).toEqual(["hook2_inline"]);
  });

  it("follows a returned function declaration and a returned identifier", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          export function useTracker() { const send = (n: string) => { t.track(n); }; return send; }
          const track = useTracker();
          track("hook2_ident");`,
      }),
    ).toEqual(["hook2_ident"]);
  });
});

describe("a cached lazy getter for the tracker", () => {
  it("follows `(await getT()).track(...)` through a wrapper", async () => {
    expect(
      await eventsOf({
        "a.ts": `let t: any;
          export async function getT() {
            if (!t) { const { Eventra } = await import("@eventra_dev/eventra-sdk"); t = new Eventra({ apiKey: "x" }); }
            return t;
          }
          export async function track(n: string) { (await getT()).track(n); }
          track("lazy3_event");`,
      }),
    ).toEqual(["lazy3_event"]);
  });
});

describe("a hook whose returned function has no block around it", () => {
  const SDK = `import { Eventra } from "@eventra_dev/eventra-sdk"; const t = new Eventra({ apiKey: "x" });`;

  it("follows an arrow hook with a concise body: `const useTracker = () => (n) => t.track(n)`", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          const useTracker = () => (n: string) => { t.track(n); };
          useTracker()("concise_hook");`,
      }),
    ).toEqual(["concise_hook"]);
  });

  it("sees through parentheses around the returned function, in the hook and in the call", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          const useTracker = () => ((n: string) => { t.track(n); });
          useTracker()("paren_hook");`,
      }),
    ).toEqual(["paren_hook"]);
  });

  it("sees through `as`, `!`, `satisfies` and angle brackets around a returned function", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          type Fn = (n: string) => void;
          function useCast() { return ((n: string) => { t.track(n); }) as Fn; }
          function useNonNull() { return ((n: string) => { t.track(n); })!; }
          function useSatisfies() { return ((n: string) => { t.track(n); }) satisfies Fn; }
          function useAngle() { return <Fn>((n: string) => { t.track(n); }); }
          function useNested() { return (((n: string) => { t.track(n); }) as Fn)!; }
          useCast()("cast_hook");
          useNonNull()("nonnull_hook");
          useSatisfies()("satisfies_hook");
          useAngle()("angle_hook");
          useNested()("nested_hook");`,
      }),
    ).toEqual(["angle_hook", "cast_hook", "nested_hook", "nonnull_hook", "satisfies_hook"]);
  });

  it("sees through `as` and `!` around the concise body of an arrow hook", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          type Fn = (n: string) => void;
          const useCast = () => ((n: string) => { t.track(n); }) as Fn;
          const useNonNull = () => ((n: string) => { t.track(n); })!;
          useCast()("concise_cast");
          useNonNull()("concise_nonnull");`,
      }),
    ).toEqual(["concise_cast", "concise_nonnull"]);
  });

  it("does not take a function for a returned one when it is only an argument or a default", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          function run(cb: (n: string) => void) { cb("arg_cb"); }
          function wrap(fn = (n: string) => { t.track(n); }) { return 1; }
          const holder = () => run((n: string) => { t.track(n); });
          holder();`,
      }),
    ).toEqual([]);
  });

  it("follows an anonymous hook held by an object member or a function expression", async () => {
    // an anonymous hook held by an object member and one held by a function expression both resolve
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          const hooks = { useTracker: () => (n: string) => { t.track(n); } };
          hooks.useTracker()("member_hook");
          const useOther = function () { return (n: string) => { t.track(n); }; };
          useOther()("expr_hook");`,
      }),
    ).toEqual(["expr_hook", "member_hook"]);
  });

  it("gives up on a factory chain that is deeper than it will follow", async () => {
    const calls = (depth: number) => "()".repeat(depth);
    const chain = (depth: number) => `const c = ${"() => ".repeat(depth)}(n: string) => { t.track(n); };`;
    expect(await eventsOf({ "a.ts": `${SDK}\n${chain(3)}\nc${calls(3)}("shallow_chain");` })).toEqual(["shallow_chain"]);
    expect(await eventsOf({ "a.ts": `${SDK}\n${chain(8)}\nc${calls(8)}("deep_chain");` })).toEqual([]);
  });

  it("resolves nothing when the factory is not a function it can see", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          function run(make: () => (n: string) => void) { make()("param_factory"); }
          declare const external: () => (n: string) => void;
          external()("declared_factory");`,
      }),
    ).toEqual([]);
  });
});

describe("a getter that hands back a tracker whose type is lost", () => {
  const HEAD = `import { Eventra } from "@eventra_dev/eventra-sdk"; let t: any = new Eventra({ apiKey: "x" });`;

  it("follows a getter with a concise arrow body", async () => {
    expect(await eventsOf({ "a.ts": `${HEAD}\nconst getT = () => t;\ngetT().track("getter_arrow");` })).toEqual(["getter_arrow"]);
  });

  it("follows a getter written as a function expression", async () => {
    expect(await eventsOf({ "a.ts": `${HEAD}\nconst getT = function () { return t; };\ngetT().track("getter_expr");` })).toEqual(["getter_expr"]);
  });

  it("follows a getter that is a method", async () => {
    expect(
      await eventsOf({ "a.ts": `${HEAD}\nconst svc = { getT() { return t; } };\nsvc.getT().track("getter_method");` }),
    ).toEqual(["getter_method"]);
  });

  it("ignores a return inside a function nested in the getter", async () => {
    expect(
      await eventsOf({
        "a.ts": `${HEAD}
          let other: any;
          function getT() { const inner = () => { return t; }; inner(); return other; }
          getT().track("nested_return");`,
      }),
    ).toEqual([]);
  });

  it("follows a chain of getters up to a point, and no further", async () => {
    const chain = (depth: number) =>
      [`const g${depth} = () => t;`, ...Array.from({ length: depth }, (_, i) => `const g${depth - 1 - i} = () => g${depth - i}();`)].join("\n");
    expect(await eventsOf({ "a.ts": `${HEAD}\n${chain(3)}\ng0().track("short_chain");` })).toEqual(["short_chain"]);
    expect(await eventsOf({ "a.ts": `${HEAD}\n${chain(9)}\ng0().track("long_chain");` })).toEqual([]);
  });
});

describe("a hook that returns something that is not a function", () => {
  const SDK = `import { Eventra } from "@eventra_dev/eventra-sdk"; const t = new Eventra({ apiKey: "x" });`;

  it("resolves nothing for a returned literal, an unknown name, or a variable holding a non-function", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          function useNumber() { return 1; }
          function useMissing() { return missing; }
          function useVariable() { const v = 1; return v; }
          useNumber()("literal_hook");
          useMissing()("missing_hook");
          useVariable()("variable_hook");`,
      }),
    ).toEqual([]);
  });

  it("keeps looking at the other returns after one that is not a function", async () => {
    expect(
      await eventsOf({
        "a.ts": `${SDK}
          function useTracker(flag: boolean) {
            const v = 1;
            if (flag) return v;
            return (n: string) => { t.track(n); };
          }
          useTracker(true)("second_return");`,
      }),
    ).toEqual(["second_return"]);
  });
});

describe("a tracker reached through a receiver that cannot be followed", () => {
  const HEAD = `import { Eventra } from "@eventra_dev/eventra-sdk"; let t: any = new Eventra({ apiKey: "x" });`;

  it("does not resolve a receiver whose symbol has no declarations at all (`arguments`)", async () => {
    expect(
      await eventsOf({ "a.ts": `${HEAD}\nfunction f() { arguments.track("arguments_receiver"); }\nglobalThis.track("global_receiver");` }),
    ).toEqual([]);
  });

  it("does not resolve a getter that is called through an element access or an unknown name", async () => {
    expect(
      await eventsOf({
        "a.ts": `${HEAD}
          declare const fns: any;
          fns["get"]().track("element_callee");
          unknownGetter().track("unknown_callee");`,
      }),
    ).toEqual([]);
  });
});
