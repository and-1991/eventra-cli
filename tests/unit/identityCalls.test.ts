import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import {
  isEventraSdkIdentityCall,
  isEventraSdkTrackCall,
  trackCallMayPassUser,
} from "../../src/analysis/sdk/isEventraTrackCall";
import type { EventraConfig } from "../../src/types";

// identify()/withUser() of the SDK (SDK 2.1.0): `check` uses them to tell whether the code says whose events
// they are, and `withUser(id).track(...)` must be found as an event like `tracker.track(...)`.

function withProject<T>(files: Record<string, string>, run: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-calls-"));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function lastCall(files: Record<string, string>, test: (call: ts.CallExpression, checker: ts.TypeChecker) => boolean): boolean {
  return withProject(files, (root) => {
    const ctx = new CompilerContext(root);
    const shim = path.join(root, "node_modules", "@eventra_dev", "eventra-sdk", "dist", "index.d.ts");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    ctx.updateFile(shim, EVENTRA_SDK_SHIM);
    for (const [rel, content] of Object.entries(files)) ctx.updateFile(path.join(root, rel), content);
    const source = ctx.getSourceFile(path.join(root, "a.ts"))!;
    const last = source.statements[source.statements.length - 1];
    // the outermost call of the last statement
    let call: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (!call && ts.isCallExpression(node)) call = node;
      else ts.forEachChild(node, visit);
    };
    visit(last);
    return test(call!, ctx.getChecker());
  });
}

const SDK = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst tracker = new Eventra({ apiKey: "k" });\n`;

describe("isEventraSdkIdentityCall", () => {
  it.each([
    ["identify()", `${SDK}tracker.identify("u1");`],
    ["withUser()", `${SDK}tracker.withUser("u1");`],
    ["an element access", `${SDK}tracker["identify"]("u1");`],
    ["an optional call", `${SDK}tracker?.withUser("u1");`],
  ])("finds %s on the SDK", (_label, code) => {
    expect(lastCall({ "a.ts": code }, isEventraSdkIdentityCall)).toBe(true);
  });

  it.each([
    ["identify() of another object", `const other = { identify(id: string) {} };\nother.identify("u1");`],
    ["a plain function", `function identify(id: string) {}\nidentify("u1");`],
    ["another SDK method", `${SDK}tracker.reset();`],
    ["a computed element access", `${SDK}const m = "identify";\n(tracker as any)[m]("u1");`],
  ])("ignores %s", (_label, code) => {
    expect(lastCall({ "a.ts": code }, isEventraSdkIdentityCall)).toBe(false);
  });
});

describe("track() through withUser()", () => {
  it("is an SDK track call when chained", () => {
    expect(lastCall({ "a.ts": `${SDK}tracker.withUser("u1").track("invoice.created");` }, isEventraSdkTrackCall)).toBe(true);
  });

  it("is an SDK track call through a variable holding the scope", () => {
    expect(
      lastCall({ "a.ts": `${SDK}const scope = tracker.withUser("u1");\nscope.track("invoice.created");` }, isEventraSdkTrackCall),
    ).toBe(true);
  });

  it.each([
    [
      "a tracker created on first use by a getter",
      `import { Eventra } from "@eventra_dev/eventra-sdk";\nlet tracker;\nfunction getTracker() { if (!tracker) tracker = new Eventra({ apiKey: "k" }); return tracker; }\ngetTracker().withUser("u").track("x");`,
    ],
    [
      "a tracker typed any and assigned later",
      `import { Eventra } from "@eventra_dev/eventra-sdk";\nlet tracker: any;\ntracker = new Eventra({ apiKey: "k" });\ntracker.withUser("u").track("x");`,
    ],
    ["an optional chain", `${SDK}tracker?.withUser("u").track("x");`],
  ])("is an SDK track call through %s", (_label, code) => {
    expect(lastCall({ "a.ts": code }, isEventraSdkTrackCall)).toBe(true);
  });

  it("is not when the chain goes through another method of the tracker", () => {
    expect(lastCall({ "a.ts": `${SDK}(tracker as any).other("u").track("x");` }, isEventraSdkTrackCall)).toBe(false);
  });

  it("is not a computed element access, which may name any method", () => {
    expect(
      lastCall({ "a.ts": `${SDK}const method = "track";\n(tracker as any)[method]("x");` }, isEventraSdkTrackCall),
    ).toBe(false);
  });

  it("is not another type of the SDK package that happens to have a track method", () => {
    const pkg = `declare module "@eventra_dev/eventra-sdk" {\n  export interface Recorder { track(name: string): void }\n}\n`;
    expect(
      lastCall(
        {
          "types.d.ts": pkg,
          "a.ts": `import type { Recorder } from "@eventra_dev/eventra-sdk";\ndeclare const r: Recorder;\nr.track("x");`,
        },
        isEventraSdkTrackCall,
      ),
    ).toBe(false);
  });

  it("is not another class of the SDK package that happens to have a track method", () => {
    const pkg = `declare module "@eventra_dev/eventra-sdk" {\n  export class Recorder { track(name: string): void }\n}\n`;
    expect(
      lastCall(
        {
          "types.d.ts": pkg,
          "a.ts": `import { Recorder } from "@eventra_dev/eventra-sdk";\nconst r = new Recorder();\nr.track("x");`,
        },
        isEventraSdkTrackCall,
      ),
    ).toBe(false);
  });

  it("is not when withUser() belongs to another object", () => {
    expect(
      lastCall(
        { "a.ts": `const other: any = { withUser: () => ({ track() {} }) };\nother.withUser("u").track("x");` },
        isEventraSdkTrackCall,
      ),
    ).toBe(false);
  });

  it("is not when the user's own interface is merely called EventraScope", () => {
    expect(
      lastCall(
        {
          "a.ts": `interface EventraScope { track(name: string): void }\ndeclare const scope: EventraScope;\nscope.track("x");`,
        },
        isEventraSdkTrackCall,
      ),
    ).toBe(false);
  });
});

describe("trackCallMayPassUser", () => {
  const may = (args: string) => lastCall({ "a.ts": `${SDK}tracker.track("e"${args});` }, (call) => trackCallMayPassUser(call));

  it.each([
    [", { userId: id }", `const id = "u";\n`],
    [", { userId }", `const userId = "u";\n`],
    [', { "userId": "u" }', ""],
    [", { ...extra }", `const extra = {};\n`],
    [", options", `const options = {};\n`],
    [", ({ userId: \"u\" } as any)", ""],
    [", <TrackOptions>{ userId: \"u\" }", `import type { TrackOptions } from "@eventra_dev/eventra-sdk";\n`],
  ])("counts %s as maybe passing a user", (args, setup) => {
    expect(lastCall({ "a.ts": `${SDK}${setup}tracker.track("e"${args});` }, (call) => trackCallMayPassUser(call))).toBe(true);
  });

  it("counts a getter named userId as passing a user, and a method or another key as not", () => {
    expect(may(", { get userId() { return \"u\"; } }")).toBe(true);
    expect(may(", { userId() { return \"u\"; } }")).toBe(false);
    expect(may(", { properties: { userId: \"u\" }, other: 1 }")).toBe(false);
    expect(may(", { other: 1, userId: \"u\" }")).toBe(true);
  });

  it.each([[""], [", { properties: { a: 1 } }"], [", { [key]: 1 }"]])("counts track(\"e\"%s) as passing no user", (args) => {
    expect(
      lastCall({ "a.ts": `${SDK}const key = "k";\ntracker.track("e"${args});` }, (call) => trackCallMayPassUser(call)),
    ).toBe(false);
  });

  it("reads the options after the this-argument of track.call()", () => {
    expect(lastCall({ "a.ts": `${SDK}tracker.track.call(tracker, "e", { userId: "u" });` }, (call) => trackCallMayPassUser(call))).toBe(true);
    expect(may("")).toBe(false);
  });
});

describe("EventraEngine.getIdentityUsage", () => {
  const CONFIG: EventraConfig = {
    apiKey: "",
    endpoint: "",
    events: [],
    functionWrappers: [],
    sync: { include: ["**/*.ts"], exclude: ["node_modules"] },
  };

  async function usage(files: Record<string, string>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-usage-"));
    try {
      const engine = new EventraEngine(root);
      engine.beginPreload();
      await engine.preloadFile("__eventra_sdk_types__.d.ts", EVENTRA_SDK_SHIM);
      const names: string[] = [];
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.writeFileSync(abs, content);
        await engine.preloadFile(abs, content);
        names.push(abs);
      }
      engine.endPreload();
      for (const name of names) await engine.scanFile(name, CONFIG);
      return { usage: engine.getIdentityUsage(), events: engine.getAllEvents() };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("sums the SDK track calls, those that may pass a user and the identity calls over all files", async () => {
    const result = await usage({
      "sdk.ts": `import { Eventra } from "@eventra_dev/eventra-sdk";\nexport const tracker = new Eventra({ apiKey: "k" });\n`,
      "a.ts": `import { tracker } from "./sdk";\ntracker.track("a.one");\ntracker.track("a.two", { userId: "u" });\n`,
      "b.ts": `import { tracker } from "./sdk";\nexport function login(id: string) { tracker.identify(id); }\ntracker.withUser("u").track("b.one");\n`,
    });
    expect(result.usage).toEqual({ identityCalls: 2, trackCalls: 3, trackCallsWithUser: 1 });
    expect(result.events).toEqual(["a.one", "a.two", "b.one"]);
  });

  it("reports no identity when the SDK is called without users", async () => {
    const result = await usage({
      "a.ts": `${SDK}tracker.track("a.one");\n`,
    });
    expect(result.usage).toEqual({ identityCalls: 0, trackCalls: 1, trackCallsWithUser: 0 });
  });
});
