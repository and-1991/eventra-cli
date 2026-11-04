import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import type { EventraConfig } from "../../src/types";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";
const CONFIG: EventraConfig = { apiKey: "", endpoint: "", events: [], functionWrappers: [], sync: { include: ["**/*.{ts,tsx}"], exclude: [] } };
const HEAD = `import { Eventra } from "@eventra_dev/eventra-sdk"; const sdk = new Eventra({ apiKey: "k" });\n`;

async function kinds(body: string, file = "a.ts"): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-cause-"));
  try {
    const engine = new EventraEngine(root);
    engine.beginPreload();
    await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
    const abs = path.join(root, file);
    fs.writeFileSync(abs, HEAD + body);
    await engine.preloadFile(abs, HEAD + body);
    engine.endPreload();
    await engine.runFullAnalysis([SDK_TYPES, abs], CONFIG);
    return engine
      .getAllDynamicOccurrences()
      .sort((a, b) => a.line - b.line)
      .map((o) => `${o.kind}:${o.cause}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("dynamic names: kind and cause", () => {
  it("tells the cause of a name that is not known where it is written", async () => {
    expect(
      await kinds(`
declare const v: string; declare function load(): string; declare const obj: Record<string, string>; declare const k: string;
sdk.track(process.env.EVT!);
sdk.track(import.meta.env.EVT);
sdk.track(\`a-\${v}\`);
sdk.track(load());
sdk.track(v);
sdk.track(obj[k]);
sdk.track(obj.name);
sdk.track(v + "x");
sdk.track((await Promise.resolve(load())));
`),
    ).toEqual([
      "unresolved:env",
      "unresolved:env",
      "unresolved:template",
      "unresolved:call",
      "unresolved:variable",
      "unresolved:variable",
      "unresolved:variable",
      "unresolved:expression",
      "unresolved:call",
    ]);
  });

  it("follows a constant to what it is set from", async () => {
    expect(
      await kinds(`
declare function load(): string;
const fromEnv = process.env.EVT!;
const fromCall = load();
const fromChain = fromEnv;
const object = { other: "x" } as Record<string, string>;
sdk.track(fromEnv);
sdk.track(fromCall);
sdk.track(fromChain);
sdk.track(object.missing);
`),
    ).toEqual(["unresolved:env", "unresolved:call", "unresolved:env", "unresolved:variable"]);
  });

  it("calls a name the checker does not know a variable", async () => {
    // the name is not declared anywhere, so the checker has no symbol for it
    expect(await kinds(`sdk.track(neverDeclared);`)).toEqual(["unresolved:variable"]);
  });

  it("stops following constants after a few hops, and calls what is left a variable", async () => {
    expect(
      await kinds(`
const a = process.env.EVT!; const b = a; const c = b; const d = c; const e = d;
sdk.track(e);
sdk.track(c);
`),
    ).toEqual(["unresolved:variable", "unresolved:env"]);
  });

  it("calls a tracking call inside a wrapper a wrapper, whatever shape the parameter has", async () => {
    expect(
      await kinds(`
function plain(name: string) { sdk.track(name); }
function destructured({ event }: { event: string }) { sdk.track(event); }
const arrow = (o: { a: { b: string } }) => { const { a } = o; sdk.track(a.b); };
function viaProps(props: { name: string }) { sdk.track(props.name); }
`),
    ).toEqual(["wrapper:parameter", "wrapper:parameter", "wrapper:parameter", "wrapper:parameter"]);
  });

  it("calls this.props.x in a class component a wrapper, and another this member unresolved", async () => {
    expect(
      await kinds(
        `
import React from "react";
class C extends React.Component<{ name: string }> {
  other!: string;
  render() { return <i onClick={() => { sdk.track(this.props.name); sdk.track(this.other); }} />; }
}
`,
        "c.tsx",
      ),
    ).toEqual(["wrapper:parameter", "unresolved:variable"]);
  });

  it("reports the caller of a wrapper that passes a name it does not know, with the cause", async () => {
    expect(
      await kinds(`
function track(name: string) { sdk.track(name); }
declare const v: string;
track(process.env.EVT!);
track(v);
track("known");
`),
    ).toEqual(["wrapper:parameter", "unresolved:env", "unresolved:variable"]);
  });

  it("reads the cause from a prop value at a component's use", async () => {
    expect(
      await kinds(
        `
function B({ n }: { n: string }) { return <i onClick={() => sdk.track(n)} />; }
declare const v: string;
export const P = () => <B n={v} />;
`,
        "b.tsx",
      ),
    ).toEqual(["wrapper:parameter", "unresolved:variable"]);
  });
});
