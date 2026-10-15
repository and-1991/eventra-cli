import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { normalizeConfig } from "../../src/config/config";
import { createPluginRegistry } from "../../src/plugin/loadPlugins";
import { resolveWrapperChains } from "../../src/analysis/scanner/wrapperChains";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";
const CONFIG = normalizeConfig({ sinks: [{ preset: "posthog" }] });

// a wrapper over the SDK call, reused by most cases
const CAP = `import posthog from "posthog-js";
export function cap(e: string, p?: object) { posthog.capture(e, p); }`;

async function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-chains-"));
  // written first: the engine reads tsconfig.json when it is created
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
    if (!/\.ts$/.test(rel)) continue;
    const abs = path.join(root, rel);
    await engine.preloadFile(abs, content);
    names.push(abs);
  }
  engine.endPreload();
  await engine.runFullAnalysis(names, CONFIG);
  return { engine, root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function eventsOf(files: Record<string, string>) {
  const { engine, cleanup } = await project(files);
  try {
    return { events: engine.getAllEvents(), wrappers: engine.getAllFunctionWrappers() };
  } finally {
    cleanup();
  }
}

describe("wrapper chains: a wrapper that calls another wrapper", () => {
  it("follows two levels across files, whatever order the files are indexed in", async () => {
    const { events, wrappers } = await eventsOf({
      // sorts before cap.ts: its wrapper is looked at before the inner one exists
      "a_track.ts": `import { cap } from "./cap";
        export function track(event: string, props?: object): void { cap(event, props); }`,
      "cap.ts": CAP,
      "use.ts": `import { track } from "./a_track"; import { cap } from "./cap";
        cap("depth.one"); track("depth.two");`,
    });
    expect(events).toEqual(["depth.one", "depth.two"]);
    expect(wrappers).toEqual(["cap", "track"]);
  });

  it("follows three levels", async () => {
    const { events } = await eventsOf({
      "cap.ts": CAP,
      "mid.ts": `import { cap } from "./cap"; export const mid = (e: string) => cap(e);`,
      "top.ts": `import { mid } from "./mid"; export function top(e: string) { mid(e); }`,
      "use.ts": `import { top } from "./top"; top("depth.three");`,
    });
    expect(events).toEqual(["depth.three"]);
  });

  it("follows a generic wrapper with a constrained event parameter", async () => {
    const { events } = await eventsOf({
      "cap.ts": CAP,
      "track.ts": `import { cap } from "./cap";
        export function trackEvent<E extends "a:one" | "a:two">(event: E, props?: object): void {
          if (event === "a:two") return;
          cap(event, props);
        }`,
      "use.ts": `import { trackEvent } from "./track"; trackEvent("a:one", { x: 1 }); trackEvent("a:two");`,
    });
    expect(events).toEqual(["a:one", "a:two"]);
  });

  it("resolves aliased imports (tsconfig paths) on the way", async () => {
    const { engine, cleanup } = await project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } }, include: ["src"] }),
      "src/cap.ts": CAP,
      "src/track.ts": `import { cap } from "@/cap"; export function track(e: string) { cap(e); }`,
      "src/use.ts": `import { track } from "@/track"; track("aliased.event");`,
    });
    try {
      expect(engine.getAllEvents()).toEqual(["aliased.event"]);
    } finally {
      cleanup();
    }
  });

  it("reads the name from a destructured parameter that is forwarded", async () => {
    const { events } = await eventsOf({
      "cap.ts": CAP,
      "track.ts": `import { cap } from "./cap"; export function track({ event }: { event: string }) { cap(event); }`,
      "use.ts": `import { track } from "./track"; track({ event: "from.object" });`,
    });
    expect(events).toEqual(["from.object"]);
  });

  it("forwards an object literal to a wrapper that reads one of its properties", async () => {
    const { events } = await eventsOf({
      "cap.ts": `import posthog from "posthog-js";
        export function cap({ event }: { event: string }) { posthog.capture(event); }`,
      "track.ts": `import { cap } from "./cap"; export function track(name: string) { cap({ event: name }); }`,
      "use.ts": `import { track } from "./track"; track("object.forwarded");`,
    });
    expect(events).toEqual(["object.forwarded"]);
  });

  it("reports a computed name as dynamic instead of inventing an event", async () => {
    const { engine, cleanup } = await project({
      "cap.ts": CAP,
      "track.ts": `import { cap } from "./cap"; export function track(e: string) { cap(e); }`,
      "use.ts": `import { track } from "./track"; export function f(name: string) { track(name); }`,
    });
    try {
      expect(engine.getAllEvents()).toEqual([]);
      expect(engine.getAllDynamicOccurrences().map((o) => `${path.basename(o.fileName)}:${o.calleeText}`)).toContain("use.ts:track");
    } finally {
      cleanup();
    }
  });

  it("does not chain a wrapper whose caller hands over a whole object it cannot look inside", async () => {
    const { events } = await eventsOf({
      "cap.ts": `import posthog from "posthog-js";
        export function cap(o: { event: string }) { posthog.capture(o.event); }`,
      "track.ts": `import { cap } from "./cap"; export function track(o: { event: string }) { cap(o); }`,
      "use.ts": `import { track } from "./track"; track({ event: "whole.object" });`,
    });
    // cap itself still resolves its own direct call sites, track is simply not a wrapper
    expect(events).not.toContain("whole.object");
  });

  it("terminates on wrappers that call each other", async () => {
    const { events } = await eventsOf({
      "cap.ts": CAP,
      "cycle.ts": `import { cap } from "./cap";
        export function a(e: string, n = 0): void { if (n > 0) b(e, n - 1); else cap(e); }
        export function b(e: string, n = 0): void { a(e, n); }`,
      "use.ts": `import { a, b } from "./cycle"; a("cycle.a"); b("cycle.b");`,
    });
    expect(events).toEqual(["cycle.a", "cycle.b"]);
  });

  it("ignores a function that only calls itself", async () => {
    const { events, wrappers } = await eventsOf({
      "self.ts": `export function loop(e: string): void { loop(e); }
        loop("never.tracked");`,
    });
    expect(events).toEqual([]);
    expect(wrappers).toEqual([]);
  });

  it("keeps a wrapper that has both a direct sink and a chained call", async () => {
    const { events } = await eventsOf({
      "cap.ts": CAP,
      "both.ts": `import posthog from "posthog-js"; import { cap } from "./cap";
        export function both(first: string, second: string) { posthog.capture(first); cap(second); }`,
      "use.ts": `import { both } from "./both"; both("both.first", "both.second");`,
    });
    expect(events).toEqual(["both.first", "both.second"]);
  });

  it("still finds the chain after a file changes (watch / incremental update)", async () => {
    const { engine, root, cleanup } = await project({
      "cap.ts": CAP,
      "track.ts": `import { cap } from "./cap"; export function track(e: string) { cap(e); }`,
      "use.ts": `import { track } from "./track"; track("before.change");`,
    });
    try {
      const use = path.join(root, "use.ts");
      const next = `import { track } from "./track"; track("before.change"); track("after.change");`;
      fs.writeFileSync(use, next);
      await engine.updateFile(use, next, CONFIG);
      expect(engine.getAllEvents()).toEqual(["after.change", "before.change"]);
    } finally {
      cleanup();
    }
  });

  it("scanFile on a single file sees chains through the other indexed files", async () => {
    const { engine, root, cleanup } = await project({
      "cap.ts": CAP,
      "track.ts": `import { cap } from "./cap"; export function track(e: string) { cap(e); }`,
      "use.ts": `import { track } from "./track"; track("single.file");`,
    });
    try {
      const result = await engine.scanFile(path.join(root, "use.ts"), CONFIG);
      expect([...result.events]).toEqual(["single.file"]);
    } finally {
      cleanup();
    }
  });

  it("ignores an inner call that leaves the forwarded argument out", async () => {
    const { events } = await eventsOf({
      "cap.ts": CAP,
      "track.ts": `import { cap } from "./cap"; export function track(): void {
        // @ts-expect-error the forwarded argument is missing on purpose
        cap();
      }`,
      "use.ts": `import { track } from "./track"; track();`,
    });
    expect(events).toEqual([]);
  });

  it("has nothing to do for an index that carries no function list", () => {
    const index = { fileName: "x.ts", sourceFile: undefined as never, sinks: [], trackCalls: [], wrappers: [] };
    expect(resolveWrapperChains([index], {} as never, {} as never, {} as never, {} as never).size).toBe(0);
  });
});
