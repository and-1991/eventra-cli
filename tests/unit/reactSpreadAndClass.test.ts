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
  sync: { include: ["**/*.{ts,tsx}"], exclude: [] },
};
const HEAD = `import { Eventra } from "@eventra_dev/eventra-sdk"; const sdk = new Eventra({ apiKey: "k" });`;

async function scan(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "component-props-"));
  try {
    const engine = new EventraEngine(root);
    engine.beginPreload();
    await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
    const names = [SDK_TYPES];
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.writeFileSync(abs, content);
      await engine.preloadFile(abs, content);
      names.push(abs);
    }
    engine.endPreload();
    await engine.runFullAnalysis(names, CONFIG);
    return { events: engine.getAllEvents().sort(), wrappers: engine.getAllFunctionWrappers().sort() };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("React: spread props", () => {
  it("reads a spread of an object literal", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function A(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      export const P = () => <A {...{ name: "spread.literal" }} />;` });
    expect(events).toEqual(["spread.literal"]);
  });

  it("reads a spread of a const object, through a rename", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function A(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      const base = { name: "spread.const" };
      const again = base;
      export const P = () => <A {...again} />;` });
    expect(events).toEqual(["spread.const"]);
  });

  it("lets a property written after the spread win, and one written before lose", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function A(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      const rest = { name: "spread.loses" };
      export const P = () => <><A {...rest} name="spread.after" /><A name="explicit.before" {...{ name: "spread.wins" }} /></>;` });
    expect(events).toEqual(["spread.after", "spread.wins"]);
  });

  it("does not guess when the spread is something it cannot read", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      declare function load(): { name: string };
      function A(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      export const P = () => <A {...load()} />;
      export const Q = (p: { name: string }) => <A {...p} name={undefined as any} {...p} />;` });
    expect(events).toEqual([]);
  });

  it("follows a component that forwards all its props with {...props}", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function Inner(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      function Outer(props: { name: string }) { return <Inner {...props} />; }
      export const P = () => <Outer name="spread.forward" />;` });
    expect(events).toEqual(["spread.forward"]);
  });

  it("follows a forward of part of the props, and a destructured rest", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function Inner(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      function Outer(props: { meta: { name: string } }) { return <Inner {...props.meta} />; }
      export const P = () => <Outer meta={{ name: "spread.partial" }} />;` });
    expect(events).toEqual(["spread.partial"]);
  });

  it("follows a spread inside a plain call too", async () => {
    const { events } = await scan({ "a.ts": `${HEAD}
      function wrap(options: { event: string }) { sdk.track(options.event); }
      function outer(options: { event: string }) { wrap({ ...options }); }
      outer({ event: "spread.call" });` });
    expect(events).toEqual(["spread.call"]);
  });
});

describe("React: class components", () => {
  it("reads this.props.x in render() and in a handler", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      import React from "react";
      class C extends React.Component<{ name: string; other: string }> {
        render() { return <i onClick={() => sdk.track(this.props.name)} />; }
      }
      export const P = () => <C name="class.render" other="not.an.event" />;` });
    expect(events).toEqual(["class.render"]);
  });

  it("reads props destructured into a local, in a class field handler", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      import React, { Component } from "react";
      class C extends Component<{ name: string }> {
        handle = () => { const { name } = this.props; sdk.track(name); };
        render() { return <i onClick={this.handle} />; }
      }
      export const P = () => <C name="class.destructured" />;` });
    expect(events).toEqual(["class.destructured"]);
  });

  it("reads PureComponent, a nested prop and a local that holds the props", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      import React from "react";
      class C extends React.PureComponent<{ meta: { id: string } }> {
        track() { const p = this.props; sdk.track(p.meta.id); }
        render() { return <i onClick={() => this.track()} />; }
      }
      export const P = () => <C meta={{ id: "class.pure" }} />;` });
    expect(events).toEqual(["class.pure"]);
  });

  it("works through a spread and from another file", async () => {
    const { events } = await scan({
      "c.tsx": `${HEAD}
        import React from "react";
        export class C extends React.Component<{ name: string }> { render() { return <i onClick={() => sdk.track(this.props.name)} />; } }`,
      "p.tsx": `import { C } from "./c"; const props = { name: "class.imported" }; export const P = () => <C {...props} />;`,
    });
    expect(events).toEqual(["class.imported"]);
  });

  it("does not follow a class that is not a React component, or a prop the class never tracks", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      import React from "react";
      class NotComponent { props = { name: "x" }; render() { return sdk.track(this.props.name); } }
      class C extends React.Component<{ name: string; label: string }> {
        render() { return <i>{this.props.label}</i>; }
      }
      export const P = () => <C name="not.tracked" label="not.tracked.either" />;` });
    expect(events).toEqual([]);
  });

  it("forwards this.props to a child with a spread, and a prop to a child as an attribute", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      import React from "react";
      function Inner(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      class A extends React.Component<{ name: string }> { render() { return <Inner {...this.props} />; } }
      class B extends React.Component<{ other: string }> { render() { return <Inner name={this.props.other} />; } }
      export const P = () => <><A name="class.spread" /><B other="class.attribute" /></>;` });
    expect(events).toEqual(["class.attribute", "class.spread"]);
  });

  it("reads a prop by a string key, and does not follow a computed key", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      import React from "react";
      declare const key: string;
      class C extends React.Component<{ name: string }> {
        render() { return <i onClick={() => { sdk.track(this.props["name"]); sdk.track(this.props[key]); }} />; }
      }
      export const P = () => <C name="class.string.key" />;` });
    expect(events).toEqual(["class.string.key"]);
  });

  it("skips methods and accessors of an object when it looks for a property, in a spread and in a call", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function A(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      const rest = { name: "skip.methods", get other() { return 1; }, method() {} };
      function wrap(options: { event: string }) { sdk.track(options.event); }
      wrap({ event: "skip.in.call", run() {} });
      export const P = () => <A {...rest} />;` });
    expect(events).toEqual(["skip.in.call", "skip.methods"]);
  });

  it("looks past a spread that does not hold the property, and past a class that is no component or has no render", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      import React from "react";
      declare function mixin(): typeof React.Component;
      function A(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      class Mixed extends mixin() { render() { return <i onClick={() => sdk.track(this.props.name)} />; } }
      class NoRender extends React.Component<{ name: string }> { go() { sdk.track(this.props.name); } }
      export const P = () => <><A {...{ name: "earlier.wins" }} {...{ other: 1 }} /><Mixed name="not.followed" /><NoRender name="not.followed.either" /></>;` });
    expect(events).toEqual(["earlier.wins"]);
  });

  it("does not read a spread of a variable it cannot trust, and handles numeric keys and long chains", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      declare const ambient: { name: string };
      function A(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      let mutable = { name: "mutable.not.read" };
      const numeric = { name: "numeric.key", 5: "five" };
      const c0 = { name: "chain.too.long" }; const c1 = { ...c0 }; const c2 = { ...c1 }; const c3 = { ...c2 }; const c4 = { ...c3 }; const c5 = { ...c4 };
      export const P = () => <><A {...mutable} /><A {...ambient} /><A {...numeric} /><A {...c5} /></>;` });
    expect(events).toEqual(["numeric.key"]);
  });

  it("skips a method of an object literal that is passed to a wrapper", async () => {
    const { events } = await scan({ "a.ts": `${HEAD}
      function wrap(options: { event: string }) { sdk.track(options.event); }
      function outer(input: { event: string }) { wrap({ run() {}, event: input.event }); }
      outer({ event: "method.skipped" });` });
    expect(events).toEqual(["method.skipped"]);
  });

  it("reads string keys and shorthand properties of a spread object, and not a spread of a parameter", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function A(props: { name: string; "data-x"?: string }) { return <i onClick={() => { sdk.track(props.name); sdk.track(props["data-x"]!); }} />; }
      const name = "shorthand.key";
      const quoted = { "data-x": "string.key" };
      const short = { name };
      export const P = (given: { name: string }) => <><A {...short} {...quoted} /><A {...given} /></>;` });
    expect(events).toEqual(["shorthand.key", "string.key"]);
  });
});

describe("React: rest props", () => {
  it("follows ...rest forwarded to another component, and reads rest.x", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function Inner(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      function Outer({ label, ...rest }: { label: string; name: string }) { return <Inner {...rest} />; }
      function Reads({ label, ...rest }: { label: string; name: string }) { return <i onClick={() => sdk.track(rest.name)} />; }
      export const P = () => <><Outer label="l" name="rest.forwarded" /><Reads label="l" name="rest.read" /></>;` });
    expect(events).toEqual(["rest.forwarded", "rest.read"]);
  });

  it("does not take a prop the pattern named beside the rest", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function Inner(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      function Outer({ name, ...rest }: { name: string; other: string }) { return <Inner {...rest} />; }
      function Reads({ name, ...rest }: { name: string; other: string }) { return <i onClick={() => sdk.track((rest as any).name)} />; }
      function Alias({ name, ...rest }: { name: string }) { const { name: again } = rest as any; return <i onClick={() => sdk.track(again)} />; }
      export const P = () => <><Outer name="not.in.rest" other="o" /><Reads name="not.in.rest" other="o" /><Alias name="not.in.rest" /></>;` });
    expect(events).toEqual([]);
  });

  it("follows a rest through a nested pattern and an alias of the rest", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      function Inner(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      function Outer({ meta: { id, ...inner } }: { meta: { id: string; name: string } }) { const same = inner; return <Inner {...same} />; }
      function Alias({ a, ...rest }: { a: string; name: string }) { const { name } = rest; return <i onClick={() => sdk.track(name)} />; }
      export const P = () => <><Outer meta={{ id: "i", name: "rest.nested" }} /><Alias a="a" name="rest.alias" /></>;` });
    expect(events).toEqual(["rest.alias", "rest.nested"]);
  });

  it("follows a rest when a computed key is named beside it", async () => {
    const { events } = await scan({ "a.tsx": `${HEAD}
      declare const key: string;
      function Inner(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
      function Outer({ [key]: other, ...rest }: { name: string } & Record<string, string>) { return <Inner {...rest} />; }
      export const P = () => <Outer name="rest.computed" />;` });
    expect(events).toEqual(["rest.computed"]);
  });
});
