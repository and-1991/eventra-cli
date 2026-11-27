import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: {
    include: ["**/*.{ts,tsx,js,jsx}"],
    exclude: ["node_modules", "dist", ".next", ".git"],
  },
};

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "property-propagation-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function preloadEngine(
  engine: EventraEngine,
  root: string,
  files: Record<string, string>,
): Promise<string[]> {
  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
  const fileNames: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    await engine.preloadFile(abs, content);
    fileNames.push(abs);
  }
  engine.endPreload();
  return [SDK_TYPES, ...fileNames];
}

async function run(files: Record<string, string>) {
  const { root, cleanup } = makeProject();
  try {
    const engine = new EventraEngine(root);
    const names = await preloadEngine(engine, root, files);
    await engine.runFullAnalysis(names, CONFIG);
    return {
      events: engine.getAllEvents(),
      wrappers: engine.getAllFunctionWrappers(),
    };
  } finally {
    cleanup();
  }
}

// Regression coverage for a gap where a wrapper's own tracked argument (e.g.
// `payload.event`) got its propertyPath applied twice: once to narrow the
// call-site value down to the leaf, and again when the extractor re-evaluated
// the wrapper's un-narrowed source expression against a parameter binding
// that was no longer the object it expected. The wrapper was correctly
// detected in every case below, but the literal event name was silently
// dropped — surfacing only as an unresolved dynamic occurrence.
describe("wrapper property propagation", () => {
  it("resolves a direct property access on the wrapper parameter", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackWrapper(payload: { event: string }) {
          sdk.track(payload.event);
        }
      `,
      "app.ts": `
        import { trackWrapper } from "./tracker";
        trackWrapper({ event: "checkout_property" });
      `,
    });
    expect(wrappers).toContain("trackWrapper");
    expect(events).toContain("checkout_property");
  });

  it("resolves optional chaining property access on the wrapper parameter", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackWrapperOpt(payload?: { event: string }) {
          // @ts-ignore
          sdk.track(payload?.event);
        }
      `,
      "app.ts": `
        import { trackWrapperOpt } from "./tracker";
        trackWrapperOpt({ event: "checkout_optional" });
      `,
    });
    expect(wrappers).toContain("trackWrapperOpt");
    expect(events).toContain("checkout_optional");
  });

  it("resolves a nested (multi-level) property access on the wrapper parameter", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackObjectWrapper(payload: { nested: { event: string } }) {
          sdk.track(payload.nested.event);
        }
      `,
      "app.ts": `
        import { trackObjectWrapper } from "./tracker";
        trackObjectWrapper({ nested: { event: "checkout_object_wrapper" } });
      `,
    });
    expect(wrappers).toContain("trackObjectWrapper");
    expect(events).toContain("checkout_object_wrapper");
  });

  it("resolves a destructured parameter", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackDestructured({ event }: { event: string }) {
          sdk.track(event);
        }
      `,
      "app.ts": `
        import { trackDestructured } from "./tracker";
        trackDestructured({ event: "destructured_param" });
      `,
    });
    expect(wrappers).toContain("trackDestructured");
    expect(events).toContain("destructured_param");
  });

  it("resolves an aliased destructured parameter", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackAliased({ event: name }: { event: string }) {
          sdk.track(name);
        }
      `,
      "app.ts": `
        import { trackAliased } from "./tracker";
        trackAliased({ event: "aliased_destructured" });
      `,
    });
    expect(wrappers).toContain("trackAliased");
    expect(events).toContain("aliased_destructured");
  });

  it("resolves a nested destructured parameter", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackNested({ meta: { event } }: { meta: { event: string } }) {
          sdk.track(event);
        }
      `,
      "app.ts": `
        import { trackNested } from "./tracker";
        trackNested({ meta: { event: "nested_destructured" } });
      `,
    });
    expect(wrappers).toContain("trackNested");
    expect(events).toContain("nested_destructured");
  });

  it("resolves element access on the wrapper parameter", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackElementAccess(payload: { event: string }) {
          sdk.track(payload["event"]);
        }
      `,
      "app.ts": `
        import { trackElementAccess } from "./tracker";
        trackElementAccess({ event: "checkout_element_access" });
      `,
    });
    expect(wrappers).toContain("trackElementAccess");
    expect(events).toContain("checkout_element_access");
  });

  it("does not confuse an unrelated sibling property on a multi-key payload", async () => {
    const { events } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackDestructured({ event }: { event: string; userId: string }) {
          sdk.track(event);
        }
      `,
      "app.ts": `
        import { trackDestructured } from "./tracker";
        trackDestructured({ event: "checkout_multi_key", userId: "u1" });
      `,
    });
    expect(events).toContain("checkout_multi_key");
    expect(events).not.toContain("u1");
  });
});

// Regression coverage for a gap where wrapping the tracked expression in a
// type assertion or non-null assertion — routine when the source field comes
// from an optional parameter, e.g. `payload?.event as string` — made the
// wrapper invisible to the analyzer entirely (not even a dynamic occurrence),
// because the shape check never unwrapped the assertion.
describe("wrapper detection through type assertions", () => {
  it("still detects the wrapper when the tracked property access is cast", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackWrapperOpt(payload?: { event: string }) {
          sdk.track(payload?.event as string);
        }
      `,
      "app.ts": `
        import { trackWrapperOpt } from "./tracker";
        trackWrapperOpt({ event: "checkout_cast" });
      `,
    });
    expect(wrappers).toContain("trackWrapperOpt");
    expect(events).toContain("checkout_cast");
  });

  it("still detects the wrapper when the tracked property access has a non-null assertion", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        export function trackWrapperOpt(payload?: { event: string }) {
          sdk.track(payload!.event);
        }
      `,
      "app.ts": `
        import { trackWrapperOpt } from "./tracker";
        trackWrapperOpt({ event: "checkout_nonnull" });
      `,
    });
    expect(wrappers).toContain("trackWrapperOpt");
    expect(events).toContain("checkout_nonnull");
  });
});

// Regression coverage for a gap where `track(EVENTS.LOGIN)` never resolved:
// resolvePropertyAccess's only "look up a property on a global const" fallback
// handled `const EVENTS = { LOGIN: "login" }` (an object literal), never
// `enum EVENTS { LOGIN = "login" }` (an EnumDeclaration with EnumMembers) —
// despite both being documented as supported.
describe("enum member property access", () => {
  it("resolves a string enum member accessed directly", async () => {
    const { events } = await run({
      "app.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        enum EVENTS {
          LOGIN = "enum_login",
        }
        sdk.track(EVENTS.LOGIN);
      `,
    });
    expect(events).toContain("enum_login");
  });

  it("resolves a string enum member imported from another file", async () => {
    const { events } = await run({
      "events.ts": `
        export enum EVENTS {
          LOGIN = "enum_login_cross_file",
        }
      `,
      "app.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        import { EVENTS } from "./events";
        const sdk = new Eventra({ apiKey: "k" });
        sdk.track(EVENTS.LOGIN);
      `,
    });
    expect(events).toContain("enum_login_cross_file");
  });
});

// Regression coverage for a gap where a cast/non-null/parens around a
// misused object-literal argument to track() itself (not a wrapper) defeated
// the sink detector's "wrong API shape" guard (`extractTrackedArguments`
// checked `ts.isObjectLiteralExpression` on the raw, un-unwrapped argument),
// letting it slip through and resolve via the generic object-literal
// fallback in resolveNodeValue — which grabs every property value
// indiscriminately, not just one matching a real API shape.
describe("direct object-literal payloads to track() stay ignored", () => {
  it("ignores a bare object literal", async () => {
    const { events } = await run({
      "app.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        sdk.track({ event: "should_be_ignored_direct_object" });
      `,
    });
    expect(events).not.toContain("should_be_ignored_direct_object");
  });

  it("ignores an object literal wrapped in a type assertion", async () => {
    const { events } = await run({
      "app.ts": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        sdk.track({ event: "should_be_ignored_cast_object" } as any);
      `,
    });
    expect(events).not.toContain("should_be_ignored_cast_object");
  });
});

// `function track(...[event, props]: [string, object?])`: the pattern's names are the arguments themselves,
// the first one at the parameter's own position. This used to be missed without a word (not an event, not
// a dynamic name), the worst way for a scan to be wrong.
describe("wrapper rest tuple parameter", () => {
  const sdk = `
    import { Eventra } from "@eventra_dev/eventra-sdk";
    const sdk = new Eventra({ apiKey: "k" });
  `;

  it("resolves the first name of a rest tuple", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `${sdk} export function trackRest(...[event, properties]: [string, object?]) { sdk.track(event); }`,
      "app.ts": `import { trackRest } from "./tracker"; trackRest("rest_first", { a: 1 });`,
    });
    expect(wrappers).toContain("trackRest");
    expect(events).toContain("rest_first");
  });

  it("takes the name from its own place in the tuple, not the first argument", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackSecond(...[user, event]: [string, string]) { sdk.track(event); }`,
      "app.ts": `import { trackSecond } from "./tracker"; trackSecond("user_value_not_event", "rest_second");`,
    });
    expect(events).toContain("rest_second");
    expect(events).not.toContain("user_value_not_event");
  });

  it("counts a hole in the pattern as an argument", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackHole(...[, event]: [string, string]) { sdk.track(event); }`,
      "app.ts": `import { trackHole } from "./tracker"; trackHole("skipped", "rest_after_hole");`,
    });
    expect(events).toContain("rest_after_hole");
    expect(events).not.toContain("skipped");
  });

  it("adds the position of the rest parameter to the position in the tuple", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackAfter(prefix: string, ...[event]: [string]) { sdk.track(event); }`,
      "app.ts": `import { trackAfter } from "./tracker"; trackAfter("not_the_event", "rest_after_param");`,
    });
    expect(events).toContain("rest_after_param");
    expect(events).not.toContain("not_the_event");
  });

  it("follows a local const that renames the tuple name", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackAlias(...[event]: [string]) { const name = event; sdk.track(name); }`,
      "app.ts": `import { trackAlias } from "./tracker"; trackAlias("rest_alias");`,
    });
    expect(events).toContain("rest_alias");
  });

  it("keeps the tuple position through a local const that renames the name", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackAliasSecond(...[user, event]: [string, string]) { const name = event; sdk.track(name); }`,
      "app.ts": `import { trackAliasSecond } from "./tracker"; trackAliasSecond("user_not_event", "rest_alias_second");`,
    });
    expect(events).toContain("rest_alias_second");
    expect(events).not.toContain("user_not_event");
  });

  it("does not register a wrapper for a name inside an array pattern in the tuple", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `${sdk} export function trackNestedArray(...[[event]]: [[string]]) { sdk.track(event); }`,
      "app.ts": `import { trackNestedArray } from "./tracker"; trackNestedArray(["nested_array_value"]);`,
    });
    expect(wrappers).not.toContain("trackNestedArray");
    expect(events).not.toContain("nested_array_value");
  });

  it("reads a prop of an object inside the tuple", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackObject(...[{ event }, extra]: [{ event: string }, object?]) { sdk.track(event); }`,
      "app.ts": `import { trackObject } from "./tracker"; trackObject({ note: "not_the_event", event: "rest_object" });`,
    });
    expect(events).toContain("rest_object");
    expect(events).not.toContain("not_the_event");
  });

  it("is followed through another wrapper", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackInner(...[event]: [string]) { sdk.track(event); }`,
      "outer.ts": `import { trackInner } from "./tracker"; export function trackOuter(name: string) { trackInner(name); }`,
      "app.ts": `import { trackOuter } from "./outer"; trackOuter("rest_chain");`,
    });
    expect(events).toContain("rest_chain");
  });

  it("finds nothing when the call has fewer arguments than the name's place", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackShort(...[user, event]: [string, string]) { sdk.track(event); }`,
      "app.ts": `import { trackShort } from "./tracker"; trackShort("only_user");`,
    });
    expect(events).not.toContain("only_user");
  });

  it("skips patterns inside the tuple that do not hold the name", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackSkip(...[{ other }, [first], event]: [{ other: string }, string[], string]) { sdk.track(event); }`,
      "app.ts": `import { trackSkip } from "./tracker"; trackSkip({ other: "o" }, ["f"], "rest_third");`,
    });
    expect(events).toContain("rest_third");
    expect(events).not.toContain("o");
  });

  it("ignores a name that is not one of the tuple's", async () => {
    const { events, wrappers } = await run({
      "tracker.ts": `${sdk} const fixed = "fixed_name"; export function trackOther(...[event]: [string]) { sdk.track(fixed); }`,
      "app.ts": `import { trackOther } from "./tracker"; trackOther("never_the_name");`,
    });
    expect(wrappers).not.toContain("trackOther");
    expect(events).not.toContain("never_the_name");
  });

  it("does not follow a rest inside the tuple", async () => {
    const { events } = await run({
      "tracker.ts": `${sdk} export function trackNestedRest(...[first, ...others]: [string, ...string[]]) { sdk.track(others[0]); }`,
      "app.ts": `import { trackNestedRest } from "./tracker"; trackNestedRest("first_value", "other_value");`,
    });
    expect(events).not.toContain("first_value");
    expect(events).not.toContain("other_value");
  });
});
