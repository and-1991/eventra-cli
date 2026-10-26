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

describe("component props that reach a track() call", () => {
  it("detects the prop by what the component does with it, whatever it is called", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        function Button({ analyticsName }: { analyticsName: string }) {
          return <button onClick={() => sdk.track(analyticsName)} />;
        }
        export const P = () => <Button analyticsName="a.destructured" />;`,
    });
    expect(events).toEqual(["a.destructured"]);
  });

  it("reads a prop through the props object and through a nested object prop", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        function A(props: { name: string }) { return <i onClick={() => sdk.track(props.name)} />; }
        function B({ meta }: { meta: { id: string } }) { return <i onClick={() => sdk.track(meta.id)} />; }
        export const P = () => <><A name="b.props" /><B meta={{ id: "b.nested" }} /></>;`,
    });
    expect(events).toEqual(["b.nested", "b.props"]);
  });

  it("does not report a prop the component never tracks", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        function Button({ track, label }: { track: string; label: string }) {
          return <button onClick={() => sdk.track(track)}>{label}</button>;
        }
        export const P = () => <Button track="c.tracked" label="not.an.event" />;`,
    });
    expect(events).toEqual(["c.tracked"]);
  });

  it("follows a prop handed on to another component, through a destructured and a props-object read", async () => {
    const { events, wrappers } = await scan({
      "a.tsx": `${HEAD}
        function Inner({ name }: { name: string }) { return <i onClick={() => sdk.track(name)} />; }
        function Mid({ track }: { track: string }) { return <Inner name={track} />; }
        function Outer(props: { label: string }) { return <Mid track={props.label} />; }
        export const P = () => <Outer label="d.chain" />;`,
    });
    expect(events).toEqual(["d.chain"]);
    expect(wrappers).toEqual(["Inner", "Mid", "Outer"]);
  });

  it("follows a forwarded prop across files", async () => {
    const { events } = await scan({
      "inner.tsx": `${HEAD}
        export function Inner({ name }: { name: string }) { return <i onClick={() => sdk.track(name)} />; }`,
      "outer.tsx": `import { Inner } from "./inner";
        export function Outer({ track }: { track: string }) { return <Inner name={track} />; }`,
      "page.tsx": `import { Outer } from "./outer"; export const P = () => <Outer track="e.cross" />;`,
    });
    expect(events).toEqual(["e.cross"]);
  });

  it("sees through React.memo and forwardRef", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        import React, { forwardRef, memo } from "react";
        const A = React.memo(({ t }: { t: string }) => <i onClick={() => sdk.track(t)} />);
        const B = forwardRef<HTMLElement, { t: string }>(({ t }, ref) => <i ref={ref as never} onClick={() => sdk.track(t)} />);
        const C = memo(forwardRef<HTMLElement, { t: string }>(({ t }, ref) => <i ref={ref as never} onClick={() => sdk.track(t)} />));
        export const P = () => <><A t="f.memo" /><B t="f.forwardRef" /><C t="f.both" /></>;`,
    });
    expect(events).toEqual(["f.both", "f.forwardRef", "f.memo"]);
  });

  it("does not chain a plain element or a component that only reads a prop for display", async () => {
    const { events, wrappers } = await scan({
      "a.tsx": `${HEAD}
        function Label({ text }: { text: string }) { return <span title={text}>{text}</span>; }
        function Card({ title }: { title: string }) { return <div title={title}><Label text={title} /></div>; }
        export const P = () => <Card title="g.display" />;`,
    });
    expect(events).toEqual([]);
    expect(wrappers).toEqual([]);
  });
});

describe("props read through a local alias", () => {
  it("follows const destructuring, a plain alias and a property alias of the props", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        function A(p: { t: string }) { const { t } = p; return <i onClick={() => sdk.track(t)} />; }
        function B(p: { t: string }) { const q = p; return <i onClick={() => sdk.track(q.t)} />; }
        function C(p: { t: string }) { const name = p.t; return <i onClick={() => sdk.track(name)} />; }
        function D({ meta }: { meta: { id: string } }) { const { id } = meta; return <i onClick={() => sdk.track(id)} />; }
        function E(p: { m: { id: string } }) { const { m: { id: renamed } } = p; return <i onClick={() => sdk.track(renamed)} />; }
        export const P = () => <><A t="a.destructure" /><B t="b.alias" /><C t="c.property" /><D meta={{ id: "d.nested" }} /><E m={{ id: "e.deep" }} /></>;`,
    });
    expect(events).toEqual(["a.destructure", "b.alias", "c.property", "d.nested", "e.deep"]);
  });

  it("does not follow a let, a rest element or a name taken from outside the component", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        const outer = { t: "outer.value" };
        function A(p: { t: string }) { let { t } = p; return <i onClick={() => sdk.track(t)} />; }
        function B(p: { t: string }) { const { ...rest } = p; return <i onClick={() => sdk.track(rest.t)} />; }
        function C(p: { t: string }) { const { t } = outer; return <i onClick={() => sdk.track(t)} />; }
        export const P = () => <><A t="not.a" /><B t="not.b" /><C t="not.c" /></>;`,
    });
    expect(events).toEqual([]);
  });

  it("follows an alias through a chain of components and across call arguments", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        function track(name: string) { sdk.track(name); }
        function A({ x }: { x: string }) { const y = x; track(y); return null; }
        function Inner(p: { n: string }) { const { n } = p; return <i onClick={() => sdk.track(n)} />; }
        function Outer(p: { k: string }) { const { k } = p; return <Inner n={k} />; }
        export const P = () => <><A x="a.call" /><Outer k="b.chain" /></>;`,
    });
    expect(events).toEqual(["a.call", "b.chain"]);
  });
});

describe("an alias of a whole argument", () => {
  it("reads the argument a function is called with through a local copy of it", async () => {
    const { events } = await scan({
      "a.ts": `${HEAD}
        function trackIt(name: string) { const copy = name; sdk.track(copy); }
        trackIt("alias.whole");`,
    });
    expect(events).toEqual(["alias.whole"]);
  });
});

describe("components the scan has to leave alone", () => {
  it("finds nothing when the call site leaves out the prop an alias reads", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        function Button(p: { t?: string }) { const { t } = p; return <i onClick={() => sdk.track(t as string)} />; }
        export const P = () => <Button />;`,
    });
    expect(events).toEqual([]);
  });

  it("does not take memo() without a component, or an unnamed function, for a component", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        import { memo } from "react";
        // @ts-expect-error memo needs a component
        const Empty = memo();
        export default function () { sdk.track("anonymous.direct"); }
        export const P = () => <Empty t="x" />;`,
    });
    expect(events).toEqual(["anonymous.direct"]);
  });
});

describe("destructured keys that are not plain names", () => {
  it("reads the key of a string-literal binding, and follows no computed key", async () => {
    const { events } = await scan({
      "a.tsx": `${HEAD}
        function A(p: { "a-b": string }) { const { "a-b": renamed } = p; return <i onClick={() => sdk.track(renamed)} />; }
        function B({ "c-d": renamed }: { "c-d": string }) { return <i onClick={() => sdk.track(renamed)} />; }
        const key = "e";
        function C(p: { e: string }) { const { [key]: renamed } = p; return <i onClick={() => sdk.track(renamed)} />; }
        export const P = () => <><A {...{}} a-b="s.alias" /><B c-d="s.param" /><C e="not.computed" /></>;`,
    });
    expect(events).toEqual(["s.alias", "s.param"]);
  });
});
