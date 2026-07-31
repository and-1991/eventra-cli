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
