import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import type { EventraConfig } from "../../src/types";

// C10 of AUDIT-2026-11-10: a wrapper called through `.call` / `.apply` was missed without a word, and a
// template whose every part is known was listed as a dynamic name.

const SDK_TYPES = "__eventra_sdk_types__.d.ts";
const CONFIG: EventraConfig = { apiKey: "", endpoint: "", events: [], functionWrappers: [], sync: { include: ["**/*.ts"], exclude: [] } };
const HEAD = `import { Eventra } from "@eventra_dev/eventra-sdk"; const sdk = new Eventra({ apiKey: "k" });\n`;

async function scan(body: string): Promise<{ events: string[]; dynamic: string[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-call-apply-"));
  try {
    const engine = new EventraEngine(root);
    engine.beginPreload();
    await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
    const abs = path.join(root, "a.ts");
    fs.writeFileSync(abs, HEAD + body);
    await engine.preloadFile(abs, HEAD + body);
    engine.endPreload();
    await engine.runFullAnalysis([SDK_TYPES, abs], CONFIG);
    return {
      events: engine.getAllEvents().sort(),
      dynamic: engine.getAllDynamicOccurrences().filter((o) => o.kind !== "wrapper").map((o) => o.cause ?? ""),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("wrappers called through .call and .apply", () => {
  it("reads the name after `this` for .call and from the written-out array for .apply", async () => {
    const { events } = await scan(`
function trackWrapper(name: string) { sdk.track(name); }
function second(prefix: string, name: string) { sdk.track(name); }
trackWrapper.call(null, "via.call");
trackWrapper.apply(undefined, ["via.apply"]);
second.call(null, "ignored", "second.call");
second.apply(null, ["ignored", "second.apply"]);
`);
    expect(events).toEqual(["second.apply", "second.call", "via.apply", "via.call"]);
  });

  it("finds nothing through .apply when the arguments are not written out, or a spread comes first", async () => {
    const { events } = await scan(`
declare const args: [string];
declare const rest: string[];
function trackWrapper(name: string) { sdk.track(name); }
trackWrapper.apply(null, args);
trackWrapper.apply(null, [...rest, "after.spread"]);
trackWrapper.apply(null);
`);
    expect(events).toEqual([]);
  });

  it("keeps a wrapper that is itself a method named call working as before", async () => {
    const { events } = await scan(`
const tracker = { call(name: string) { sdk.track(name); } };
tracker.call("method.named.call");
`);
    expect(events).toEqual(["method.named.call"]);
  });

  // a TypeScript `this:` parameter is a type only, not an argument: the names used to be read one argument
  // too far, so every event of such a wrapper was lost without a message
  it("reads the right argument when the wrapper declares a `this:` parameter", async () => {
    const { events } = await scan(`
interface Ctx { id: number }
declare const ctx: Ctx;
function viaThis(this: Ctx, name: string) { sdk.track(name); }
function second(this: Ctx, prefix: string, name: string) { sdk.track(name); }
function direct(this: void, name: string) { sdk.track(name); }
const later = function (this: void, name: string) { return () => sdk.track(name); };
viaThis.call(ctx, "this.call");
viaThis.apply(ctx, ["this.apply"]);
second.call(ctx, "ignored", "this.second.call");
second.apply(ctx, ["ignored", "this.second.apply"]);
direct("this.direct");
later("this.returned")();
`);
    expect(events).toEqual([
      "this.apply",
      "this.call",
      "this.direct",
      "this.returned",
      "this.second.apply",
      "this.second.call",
    ]);
  });

  it("ignores .call on something that is not a wrapper", async () => {
    const { events } = await scan(`
function notAWrapper(name: string) { return name; }
notAWrapper.call(null, "not.an.event");
`);
    expect(events).toEqual([]);
  });
});

describe("templates", () => {
  it("lists a template whose every part is known as that name, not as a dynamic one", async () => {
    const { events, dynamic } = await scan(`
const type = "signup";
sdk.track(\`feature_\${type}\`);
`);
    expect(events).toEqual(["feature_signup"]);
    expect(dynamic).toEqual([]);
  });
});
