import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { normalizeConfig } from "../../src/config/config";
import { createPluginRegistry } from "../../src/plugin/loadPlugins";
import { registerConfiguredSinks, resolveSinkRules } from "../../src/plugin/builtins/configuredSinks";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import type { EventraConfig, SinkRuleConfig } from "../../src/types";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";

function baseConfig(sinks: SinkRuleConfig[]): EventraConfig {
  return normalizeConfig({ sinks });
}

async function scan(sinks: SinkRuleConfig[], files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-sinks-"));
  try {
    const config = baseConfig(sinks);
    const engine = new EventraEngine(root, await createPluginRegistry(config));
    engine.beginPreload();
    await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
    const names: string[] = [SDK_TYPES];
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      await engine.preloadFile(abs, content);
      names.push(abs);
    }
    engine.endPreload();
    await engine.runFullAnalysis(names, config);
    return { events: engine.getAllEvents(), dynamic: engine.getAllDynamicOccurrences() };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const POSTHOG = [{ preset: "posthog" }];

describe("sinks: posthog preset", () => {
  it("detects posthog.capture('x') from posthog-js", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `import posthog from "posthog-js"; posthog.capture("signup_completed", { plan: "pro" });`,
    });
    expect(events).toEqual(["signup_completed"]);
  });

  it("detects the usePostHog() hook under any variable name", async () => {
    const { events } = await scan(POSTHOG, {
      "a.tsx": `
        import { usePostHog } from "posthog-js/react";
        export function Btn() {
          const ph = usePostHog();
          return <button onClick={() => ph.capture("btn_clicked")} />;
        }
      `,
    });
    expect(events).toEqual(["btn_clicked"]);
  });

  it("detects destructured hook results", async () => {
    const { events } = await scan(POSTHOG, {
      "a.tsx": `
        import { usePostHog } from "posthog-js/react";
        const { posthog: client } = usePostHog() as any;
        client.capture("destructured_event");
      `,
    });
    expect(events).toEqual(["destructured_event"]);
  });

  it("follows a re-export chain: export { usePostHog as useAnalytics }", async () => {
    const { events } = await scan(POSTHOG, {
      "hooks/use-analytics.ts": `export { usePostHog as useAnalytics } from "posthog-js/react";`,
      "hooks/index.ts": `export * from "./use-analytics";`,
      "a.tsx": `
        import { useAnalytics } from "./hooks";
        export function C() { const analytics = useAnalytics(); analytics.capture("via_reexport"); return null; }
      `,
    });
    expect(events).toEqual(["via_reexport"]);
  });

  it("follows a local wrapper hook that returns the posthog hook", async () => {
    const { events } = await scan(POSTHOG, {
      "hooks.ts": `import { usePostHog } from "posthog-js/react"; export const useTrack = usePostHog;`,
      "a.tsx": `
        import { useTrack } from "./hooks";
        const t = useTrack(); t.capture("via_const_alias");
      `,
    });
    expect(events).toEqual(["via_const_alias"]);
  });

  it("detects posthog-node capture({ event })", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `
        import { PostHog } from "posthog-node";
        const client = new PostHog("key");
        client.capture({ distinctId: "u1", event: "server_event" });
      `,
    });
    expect(events).toEqual(["server_event"]);
  });

  it("detects this.posthog.capture and window.posthog.capture", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `
        declare const window: any;
        class S { posthog: any; run() { this.posthog.capture("from_class"); } }
        window.posthog.capture("from_window");
      `,
    });
    expect(events.sort()).toEqual(["from_class", "from_window"]);
  });

  it("does not treat an unrelated .capture() as an event", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `
        declare const camera: { capture(name: string): void };
        camera.capture("photo_taken");
        import { something } from "other-lib";
        const o = something();
        o.capture("nope");
      `,
    });
    expect(events).toEqual([]);
  });

  it("does nothing without a sinks entry", async () => {
    const { events } = await scan([], {
      "a.ts": `import posthog from "posthog-js"; posthog.capture("ignored");`,
    });
    expect(events).toEqual([]);
  });

  it("reports a non-literal name as dynamic instead of inventing an event", async () => {
    const { events, dynamic } = await scan(POSTHOG, {
      "a.ts": `import posthog from "posthog-js"; export const f = (n: string) => posthog.capture(n);`,
    });
    expect(events).toEqual([]);
    expect(dynamic).toHaveLength(1);
  });

  it("ignores capture({...}) without an event property", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `import posthog from "posthog-js"; posthog.capture({ foo: "bar" } as any);`,
    });
    expect(events).toEqual([]);
  });
});

describe("sinks: custom callee rules", () => {
  it("matches a custom callee by suffix with nameArg", async () => {
    const { events } = await scan([{ callee: "gtag", nameArg: 1 }], {
      "a.ts": `declare function gtag(...a: unknown[]): void; gtag("event", "purchase", { v: 1 });`,
    });
    expect(events).toEqual(["purchase"]);
  });

  it("matches analytics.track", async () => {
    const { events } = await scan([{ callee: "analytics.track" }], {
      "a.ts": `declare const analytics: any; analytics.track("page_viewed"); app.analytics.track("nested");
      declare const app: any;`,
    });
    expect(events.sort()).toEqual(["nested", "page_viewed"]);
  });

  it("does not match a longer identifier that merely ends with the callee", async () => {
    const { events } = await scan([{ callee: "analytics.track" }], {
      "a.ts": `declare const myanalytics: any; myanalytics.track("x");`,
    });
    expect(events).toEqual([]);
  });
});

describe("sinks: config handling", () => {
  it("warns and skips unknown presets and malformed rules", () => {
    const warnings: string[] = [];
    const rules = resolveSinkRules(
      [{ preset: "nope" }, {}, { callee: "bad callee!" }, { callee: "a.b", nameArg: -1 }, { callee: "ok.track" }],
      (m) => warnings.push(m),
    );
    expect(rules.map((r) => r.callee)).toEqual(["ok.track"]);
    expect(warnings).toHaveLength(4);
  });

  it("ignores prototype keys as preset names", () => {
    const warnings: string[] = [];
    expect(resolveSinkRules([{ preset: "constructor" }], (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("keeps sinks through normalizeConfig and omits them when empty", () => {
    expect(normalizeConfig({ sinks: [{ preset: "posthog" }] }).sinks).toEqual([{ preset: "posthog" }]);
    expect("sinks" in normalizeConfig({})).toBe(false);
    expect("sinks" in normalizeConfig({ sinks: "bad" as unknown as SinkRuleConfig[] })).toBe(false);
  });
});

describe("sinks: JSX component wrappers", () => {
  const WRAPPER = `
    import { usePostHog } from "posthog-js/react";
    export function Track({ analytics, onClick }: { analytics?: { name: string }; onClick?: () => void }) {
      const posthog = usePostHog();
      return <div onClick={() => { if (analytics?.name) posthog.capture(analytics.name); onClick?.(); }} />;
    }
    export function TrackProps(props: { analytics?: { name: string } }) {
      const posthog = usePostHog();
      return <div onClick={() => posthog.capture(props.analytics!.name)} />;
    }
    export function Plain(props: { event: string }) {
      const posthog = usePostHog();
      return <div onClick={() => posthog.capture(props.event)} />;
    }
  `;

  it("resolves a name passed as a prop object to a destructured component", async () => {
    const { events } = await scan(POSTHOG, {
      "Track.tsx": WRAPPER,
      "page.tsx": `
        import { Track } from "./Track";
        export const P = () => <Track analytics={{ name: "github_click" }}>x</Track>;
      `,
    });
    expect(events).toEqual(["github_click"]);
  });

  it("resolves the same for a non-destructured props parameter and self-closing tags", async () => {
    const { events } = await scan(POSTHOG, {
      "Track.tsx": WRAPPER,
      "page.tsx": `
        import { TrackProps, Plain } from "./Track";
        export const P = () => <><TrackProps analytics={{ name: "props_click" }} /><Plain event="plain_click" /></>;
      `,
    });
    expect(events.sort()).toEqual(["plain_click", "props_click"]);
  });

  it("does not invent events when the attribute is missing or spread", async () => {
    const { events, dynamic } = await scan(POSTHOG, {
      "Track.tsx": WRAPPER,
      "page.tsx": `
        import { Track } from "./Track";
        const rest = { analytics: { name: "hidden" } };
        export const P = () => <><Track /><Track {...rest} /></>;
      `,
    });
    expect(events).toEqual([]);
    // The wrapper's own `capture(props.x)` is always reported as dynamic; the JSX sites add nothing.
    expect(dynamic.filter((d) => d.fileName.endsWith("page.tsx"))).toEqual([]);
  });

  it("flags a non-literal name as dynamic", async () => {
    const { events, dynamic } = await scan(POSTHOG, {
      "Track.tsx": WRAPPER,
      "page.tsx": `
        import { Track } from "./Track";
        export const P = ({ n }: { n: string }) => <Track analytics={{ name: n }} />;
      `,
    });
    expect(events).toEqual([]);
    expect(dynamic.some((d) => d.fileName.endsWith("page.tsx"))).toBe(true);
  });
});

describe("sinks: posthog-node shapes (from Documenso)", () => {
  it("propagates a shorthand `event` through a wrapper, and not `distinctId`", async () => {
    const { events } = await scan(POSTHOG, {
      "server.ts": `
        import { PostHog } from "posthog-node";
        const client = new PostHog("k");
        interface Opts { event: string; userId?: number }
        export const captureServerEvent = ({ event, userId }: Opts) => {
          const posthog = client;
          posthog.capture({ distinctId: userId ? String(userId) : "anon", event, properties: { userId } });
        };
      `,
      "use.ts": `
        import { captureServerEvent } from "./server";
        captureServerEvent({ event: "envelope_sent", userId: 7 });
      `,
    });
    expect(events).toEqual(["envelope_sent"]);
  });

  it("recognises a typed class field: private client: PostHog | null", async () => {
    const { events } = await scan(POSTHOG, {
      "t.ts": `
        import { PostHog } from "posthog-node";
        class Telemetry {
          private client: PostHog | null = null;
          beat() { this.client?.capture({ distinctId: "i", event: "heartbeat" }); }
        }
      `,
    });
    expect(events).toEqual(["heartbeat"]);
  });

  it("recognises a class field initialised with new PostHog()", async () => {
    const { events } = await scan(POSTHOG, {
      "t.ts": `
        import { PostHog } from "posthog-node";
        class T { ph = new PostHog("k"); go() { this.ph.capture({ distinctId: "i", event: "init_field" }); } }
      `,
    });
    expect(events).toEqual(["init_field"]);
  });

  it("does not match a typed field from an unrelated library", async () => {
    const { events } = await scan(POSTHOG, {
      "t.ts": `
        import { Camera } from "camera-lib";
        class T { private cam: Camera | null = null; go() { this.cam?.capture({ event: "photo" }); } }
      `,
    });
    expect(events).toEqual([]);
  });
});

describe("sinks: shorthand parameter forwarding", () => {
  it("resolves a literal passed to a method that forwards `{ event }` shorthand", async () => {
    const { events } = await scan(POSTHOG, {
      "t.ts": `
        import { PostHog } from "posthog-node";
        class T {
          private client: PostHog | null = null;
          private captureEvent(event: string) { this.client?.capture({ distinctId: "i", event }); }
          start() { this.captureEvent("startup_event"); }
        }
      `,
    });
    expect(events).toEqual(["startup_event"]);
  });
});

describe("sinks: imported typed client (from Formbricks)", () => {
  it("detects capture on a client imported from a module that declares it with a PostHog type", async () => {
    const { events } = await scan(POSTHOG, {
      "server.ts": `
        import { type BeforeSendFn, PostHog } from "posthog-node";
        declare function create(): PostHog | null;
        export const posthogServerClient: PostHog | null = create();
      `,
      "capture.ts": `
        import { posthogServerClient } from "./server";
        export function capturePostHogEvent(distinctId: string, eventName: string) {
          if (!posthogServerClient) return;
          posthogServerClient.capture({ distinctId, event: eventName });
        }
      `,
      "use.ts": `
        import { capturePostHogEvent } from "./capture";
        capturePostHogEvent("u", "chart_created");
      `,
    });
    expect(events).toEqual(["chart_created"]);
  });
});

describe("sinks: names with spaces and colons", () => {
  it("keeps spaced and colon names as written for every sink shape", async () => {
    const { events } = await scan([...POSTHOG, { callee: "analytics.track" }, { callee: "gtag", nameArg: 1 }], {
      "a.tsx": `
        import posthog from "posthog-js";
        import { usePostHog } from "posthog-js/react";
        import { PostHog } from "posthog-node";
        declare const analytics: { track(n: string): void };
        declare function gtag(...a: unknown[]): void;
        const node = new PostHog("k");
        posthog.capture("App: User Sign Up");
        const ph = usePostHog(); ph.capture("Order Completed");
        node.capture({ distinctId: "u", event: "Server: Envelope Sent" });
        analytics.track("Segment Style: Checkout Started");
        gtag("event", "Add To Cart");
        posthog.capture("  Padded Name  ");
      `,
    });
    expect(events.sort()).toEqual([
      "Add To Cart",
      "App: User Sign Up",
      "Order Completed",
      "Padded Name",
      "Segment Style: Checkout Started",
      "Server: Envelope Sent",
    ]);
  });

  it("resolves spaced names through constants, template literals and wrappers", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `
        import posthog from "posthog-js";
        const PREFIX = "App";
        const NAME = "Sign Up";
        const EVENTS = { signup: "App: User Sign Up" } as const;
        export const track = (n: string) => posthog.capture(n);
        track(EVENTS.signup);
        track(\`\${PREFIX}: \${NAME}\`);
        track(NAME);
      `,
    });
    expect(events.sort()).toEqual(["App: Sign Up", "App: User Sign Up", "Sign Up"]);
  });

  it("resolves a property of an `as const` object (no spaces involved)", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `
        import posthog from "posthog-js";
        const EVENTS = { signup: "app_user_signup" } as const;
        export const track = (n: string) => posthog.capture(n);
        track(EVENTS.signup);
      `,
    });
    expect(events).toEqual(["app_user_signup"]);
  });

  it("works for the Eventra SDK and JSX event attributes as well", async () => {
    const { events } = await scan([], {
      "a.tsx": `
        import { Eventra } from "@eventra_dev/eventra-sdk";
        const sdk = new Eventra({ apiKey: "k" });
        sdk.track("SDK Direct: Sign Up");
        export const B = () => <button event="JSX Event: Click Me" />;
      `,
    });
    expect(events.sort()).toEqual(["JSX Event: Click Me", "SDK Direct: Sign Up"]);
  });

  it("still drops names with characters outside the allowed set", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `
        import posthog from "posthog-js";
        posthog.capture("$pageview");
        posthog.capture("Bang!");
        posthog.capture("tab\\there");
        posthog.capture("Ok Name");
      `,
    });
    expect(events).toContain("Ok Name");
    expect(events).not.toContain("$pageview");
    expect(events).not.toContain("Bang!");
    expect(events.some((e) => e.includes("\t"))).toBe(false);
  });

  it("drops a spaced name longer than 64 characters", async () => {
    const long = `${"word ".repeat(13)}x`;
    expect(long.length).toBeGreaterThan(64);
    const { events } = await scan(POSTHOG, {
      "a.ts": `import posthog from "posthog-js"; posthog.capture("${long}"); posthog.capture("Short Name");`,
    });
    expect(events).toEqual(["Short Name"]);
  });
});

describe("sinks: receiver resolution edge cases", () => {
  const CAP = [{ callee: "capture", modules: ["posthog-js", "posthog-node"], nameProperty: "event" }];

  it("follows export default of a client", async () => {
    const { events } = await scan(CAP, {
      "client.ts": `import posthog from "posthog-js"; export default posthog;`,
      "made.ts": `import { PostHog } from "posthog-node"; export default new PostHog("k");`,
      "a.ts": `
        import ph from "./client";
        import made from "./made";
        ph.capture("via_default_alias");
        made.capture({ distinctId: "u", event: "via_default_new" } as any);
      `,
    });
    expect(events.sort()).toEqual(["via_default_alias", "via_default_new"]);
  });

  it("follows an `export default` of a call expression and an await", async () => {
    const { events } = await scan([{ callee: "capture", modules: ["posthog-js"], nameProperty: "event" }], {
      "client.ts": `import { init } from "posthog-js"; export default init();`,
      "a.ts": `
        import { init } from "posthog-js";
        import client from "./client";
        client.capture("from_default_call");
        export async function f() { const c = await init(); c.capture("from_await"); }
      `,
    });
    expect(events.sort()).toEqual(["from_await", "from_default_call"]);
  });

  it("follows re-exports through an intermediate module (with and without renaming)", async () => {
    const { events } = await scan(CAP, {
      "b.ts": `export { usePostHog } from "posthog-js/react";`,
      "a.ts": `export { usePostHog as useA } from "./b";`,
      "c.ts": `export { useA as useC } from "./a";`,
      "use.ts": `
        import { useC } from "./c";
        const h = useC();
        h.capture("deep_chain");
      `,
    });
    expect(events).toEqual(["deep_chain"]);
  });

  it("follows a local `export { x as y }` that points at an import", async () => {
    const { events } = await scan(CAP, {
      "hook.ts": `import { usePostHog } from "posthog-js/react"; export { usePostHog as useLocal }; export { usePostHog };`,
      "use.ts": `
        import { useLocal, usePostHog } from "./hook";
        useLocal().capture("local_alias");
        usePostHog().capture("local_same_name");
      `,
    });
    expect(events.sort()).toEqual(["local_alias", "local_same_name"]);
  });

  it("follows a local export of a default import, a namespace import and a named import", async () => {
    const { events } = await scan(CAP, {
      "hook.ts": `
        import "side-effect-only";
        import ph from "posthog-js";
        import * as ns from "posthog-js";
        import { usePostHog as named } from "posthog-js/react";
        export { ph as clientA, ns as clientB, named as useC };
      `,
      "use.ts": `
        import { clientA, clientB, useC } from "./hook";
        clientA.capture("export_default_import");
        (clientB as any).capture("export_namespace_import");
        useC().capture("export_named_import");
      `,
    });
    expect(events.sort()).toEqual(["export_default_import", "export_named_import", "export_namespace_import"]);
  });

  it("does not match a local export that points at something unrelated", async () => {
    const { events } = await scan(CAP, {
      "hook.ts": `const mine = () => ({ capture(_n: string) {} }); export { mine as hook };`,
      "use.ts": `import { hook } from "./hook"; hook().capture("not_posthog");`,
    });
    expect(events).toEqual([]);
  });

  it("stops on circular re-exports instead of looping", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `export { x } from "./b";`,
      "b.ts": `export { x } from "./a";`,
      "use.ts": `import { x } from "./a"; x.capture("cycle");`,
    });
    expect(events).toEqual([]);
  });

  it("does not match a namespace import from an unrelated module, but matches the real one", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `
        import * as other from "other-lib";
        import * as ph from "posthog-js";
        (other as any).capture("nope");
        (ph as any).capture("namespace_ok");
      `,
      "b.ts": `
        import * as w from "./a";
        (w as any).capture("nope_too");
      `,
    });
    expect(events).toEqual(["namespace_ok"]);
  });

  it("does not match default or named imports from other local modules", async () => {
    const { events } = await scan(CAP, {
      "other.ts": `export default { capture(_n: string) {} }; export const named = { capture(_n: string) {} };`,
      "a.ts": `
        import other, { named } from "./other";
        other.capture("nope_default");
        named.capture("nope_named");
      `,
    });
    expect(events).toEqual([]);
  });

  it("recognises typed declarations: parenthesised, intersection, qualified and parameter types", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `
        import { PostHog } from "posthog-node";
        import * as ns from "posthog-node";
        declare let paren: (PostHog | null);
        declare let both: PostHog & { extra: 1 };
        declare let qualified: ns.PostHog;
        declare let unrelated: string;
        declare let anything: any;
        paren!.capture({ distinctId: "u", event: "paren_type" });
        both.capture({ distinctId: "u", event: "intersection_type" });
        qualified.capture({ distinctId: "u", event: "qualified_type" });
        export function f(client: PostHog) { client.capture({ distinctId: "u", event: "param_type" }); }
        (unrelated as any).capture("nope_string");
        anything.capture("nope_any");
      `,
    });
    expect(events.sort()).toEqual(["intersection_type", "param_type", "paren_type", "qualified_type"]);
  });

  it("recognises a parameter default and a destructured binding with a type", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `
        import { usePostHog } from "posthog-js/react";
        export function f(ph = usePostHog()) { ph.capture("param_default"); }
        export function g({ posthog }: { posthog: string }) { (posthog as any).capture("nope_destructured"); }
      `,
    });
    expect(events).toEqual(["param_default"]);
  });

  it("does not match a variable aliasing something unrelated, a conditional, or an unresolved receiver", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `
        import { other } from "other-lib";
        const mine = other;
        declare const flag: boolean;
        declare const a: { capture(n: string): void };
        declare const b: { capture(n: string): void };
        mine.capture("nope_alias");
        (flag ? a : b).capture("nope_conditional");
        a.b.c.capture("nope_unresolved");
        declare function build(): { capture(n: string): void };
        build().capture("nope_local_call");
        (a as any)["capture"]("nope_element");
        (build() as any).deep.capture("nope_deep");
      `,
    });
    expect(events).toEqual([]);
  });

  it("ignores bare calls, element access and non-property callees for receiver-vetted and plain rules", async () => {
    const { events } = await scan([...CAP, { callee: "analytics.track" }], {
      "a.ts": `
        import { init } from "posthog-js";
        declare const analytics: any;
        declare function capture(n: string): void;
        declare function foo(): any;
        capture("nope_bare");
        analytics["track"]("nope_element_access");
        foo().analytics.track("nope_call_head");
        (foo())("nope_call_callee");
        init();
      `,
    });
    expect(events).toEqual([]);
  });

  it("ignores a capture call without arguments, and an object without the name property", async () => {
    const { events } = await scan([{ callee: "analytics.track" }, { callee: "t.track", nameProperty: "event" }], {
      "a.ts": `
        declare const analytics: any;
        declare const t: any;
        analytics.track();
        analytics.track({ event: "nope_object_without_nameProperty" });
        t.track({ other: "nope" });
      `,
    });
    expect(events).toEqual([]);
  });
});

describe("sinks: custom rule options and registration", () => {
  it("honours nameProperty and modules on custom rules", async () => {
    const { events } = await scan(
      [
        { callee: "bus.emit", nameProperty: "type" },
        { callee: "capture", modules: ["posthog-js"] },
      ],
      {
        "a.ts": `
          import posthog from "posthog-js";
          declare const bus: { emit(e: { type: string }): void };
          bus.emit({ type: "Custom Bus: Event" });
          posthog.capture("Custom Modules: Event");
        `,
      },
    );
    expect(events.sort()).toEqual(["Custom Bus: Event", "Custom Modules: Event"]);
  });

  it("resolveSinkRules copies nameProperty and modules and defaults nameArg", () => {
    const [rule] = resolveSinkRules([{ callee: "a.b", nameProperty: "event", modules: ["x"] }], () => {});
    expect(rule).toEqual({ callee: "a.b", nameArg: 0, nameProperty: "event", modules: ["x"] });
    const [plain] = resolveSinkRules([{ callee: "a.b", nameArg: 2 }], () => {});
    expect(plain).toEqual({ callee: "a.b", nameArg: 2 });
  });

  it("registerConfiguredSinks registers one detector, and nothing for empty or all-invalid rules", () => {
    const warn = vi.fn();
    const registry = createBuiltinPluginRegistry();
    registerConfiguredSinks(registry, undefined, warn);
    registerConfiguredSinks(registry, [], warn);
    registerConfiguredSinks(registry, [{ preset: "nope" }], warn);
    expect(registry.getSinkDetectors().map((d) => d.name)).toEqual(["eventra-sdk"]);
    expect(warn).toHaveBeenCalledTimes(1);

    registerConfiguredSinks(registry, [{ preset: "posthog" }], warn);
    expect(registry.getSinkDetectors().map((d) => d.name)).toEqual(["eventra-sdk", "configured-sinks"]);
  });

  it("registerConfiguredSinks warns through console.warn by default", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      registerConfiguredSinks(createBuiltinPluginRegistry(), [{ preset: "nope" }]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("unknown sinks preset");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sinks: JSX edge cases", () => {
  it("skips namespaced tags and components whose propagation is not a props lookup", async () => {
    const { events, dynamic } = await scan(POSTHOG, {
      "Track.tsx": `
        import posthog from "posthog-js";
        export const Whole = (name: string) => posthog.capture(name);
        export const Second = (_a: string, b: string) => posthog.capture(b);
      `,
      "page.tsx": `
        import { Whole, Second } from "./Track";
        export const P = () => <><Whole /><Second /><svg:rect x="1" /></>;
      `,
    });
    expect(events).toEqual([]);
    expect(dynamic.filter((d) => d.fileName.endsWith("page.tsx"))).toEqual([]);
  });

  it("ignores spread, boolean and JSX-valued attributes when rebuilding props", async () => {
    const { events } = await scan(POSTHOG, {
      "Track.tsx": `
        import posthog from "posthog-js";
        export const Track = ({ analytics }: { analytics?: { name: string }; flag?: boolean; icon?: unknown }) => {
          if (analytics) posthog.capture(analytics.name);
          return null;
        };
      `,
      "page.tsx": `
        import { Track } from "./Track";
        const rest = {};
        export const P = () => <Track flag icon={<b />} {...rest} analytics={{ name: "Mixed Attrs: Ok" }} />;
      `,
    });
    expect(events).toEqual(["Mixed Attrs: Ok"]);
  });
});

describe("sinks: rule validation details", () => {
  it("explains every skipped rule with a specific message", () => {
    const warnings: string[] = [];
    resolveSinkRules([{ preset: "nope" }, {}, { callee: "a.b", nameArg: -1 }], (m) => warnings.push(m));
    expect(warnings).toEqual([
      'Eventra: unknown sinks preset "nope" (available: posthog, segment, amplitude, ga4) - skipped.',
      'Eventra: sinks rule needs a "preset" or a dotted "callee" like "analytics.track" - skipped.',
      'Eventra: sinks rule "a.b" has an invalid "nameArg" - skipped.',
    ]);
  });

  it("trims the callee and rejects anything that is not a plain dotted identifier path", () => {
    const warn = () => {};
    expect(resolveSinkRules([{ callee: "  analytics.track  " }], warn).map((r) => r.callee)).toEqual(["analytics.track"]);
    for (const bad of ["9lives.track", "a..b", ".a", "a.", "a b", "a-b.c", "a.b()", "a[0].b"]) {
      expect(resolveSinkRules([{ callee: bad }], warn), bad).toEqual([]);
    }
    expect(resolveSinkRules([{ callee: "$tracker._x1.go" }], warn)).toHaveLength(1);
  });

  it("rejects a non-integer nameArg", () => {
    expect(resolveSinkRules([{ callee: "a.b", nameArg: 1.5 }], () => {})).toEqual([]);
  });

  it("matches `this.`-qualified rules only on `this`", async () => {
    const { events } = await scan([{ callee: "this.tracker.track" }], {
      "a.ts": `
        declare const that: any;
        class C { tracker: any; go() { this.tracker.track("on_this"); that.tracker.track("on_that"); } }
      `,
    });
    expect(events).toEqual(["on_this"]);
  });

  it("does not match a bare-name rule against other names", async () => {
    const { events } = await scan([{ callee: "gtag", nameArg: 1 }], {
      "a.ts": `
        declare function gtag(...a: unknown[]): void;
        declare function fbq(...a: unknown[]): void;
        declare const window: any;
        gtag("event", "matched_bare");
        window.gtag("event", "matched_member");
        fbq("event", "nope_other_name");
        window.fbq("event", "nope_other_member");
      `,
    });
    expect(events.sort()).toEqual(["matched_bare", "matched_member"]);
  });
});

describe("sinks: posthog preset modules and shapes", () => {
  it.each(["posthog-js", "posthog-js/react", "@posthog/react", "posthog-js-lite", "posthog-node", "posthog-react-native"])(
    "recognises a client coming from %s",
    async (mod) => {
      const { events } = await scan(POSTHOG, {
        "a.ts": `import { Client } from "${mod}"; const c = new (Client as any)(); c.capture("from_module");`,
      });
      expect(events).toEqual(["from_module"]);
    },
  );

  it("does not recognise a similarly named package", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `import { Client } from "posthog-js-fake"; const c = new (Client as any)(); c.capture("nope");`,
    });
    expect(events).toEqual([]);
  });

  it("reads the event from an object passed to posthog.capture, and ignores a spread or method beside it", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `
        import posthog from "posthog-js";
        declare const base: { distinctId: string };
        posthog.capture({ event: "object_event" } as any);
        posthog.capture({ ...base, method() {}, event: "with_spread_and_method" } as any);
        posthog.capture({ ...base } as any);
      `,
    });
    expect(events.sort()).toEqual(["object_event", "with_spread_and_method"]);
  });
});

describe("sinks: receiver resolution limits and termination", () => {
  const CAP = [{ callee: "capture", modules: ["posthog-js"] }];

  it("accepts a re-export chain up to the hop limit and stops beyond it", async () => {
    const chain = (n: number) => {
      const files: Record<string, string> = { "f1.ts": `export { usePostHog as use1 } from "posthog-js/react";` };
      for (let i = 2; i <= n; i++) files[`f${i}.ts`] = `export { use${i - 1} as use${i} } from "./f${i - 1}";`;
      files["use.ts"] = `import { use${n} } from "./f${n}"; use${n}().capture("deep");`;
      return files;
    };
    expect((await scan(CAP, chain(6))).events).toEqual(["deep"]);
    expect((await scan(CAP, chain(7))).events).toEqual([]);
  });

  it("terminates on circular default exports", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `import b from "./b"; export default b;`,
      "b.ts": `import a from "./a"; export default a;`,
      "use.ts": `import a from "./a"; a.capture("cycle_default");`,
    });
    expect(events).toEqual([]);
  });

  it("terminates on circular initializers", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `import { y } from "./b"; export const x: any = y;`,
      "b.ts": `import { x } from "./a"; export const y: any = x;`,
      "use.ts": `import { x } from "./a"; x.capture("cycle_initializer");`,
    });
    expect(events).toEqual([]);
  });

  it("terminates on circular local re-exports", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `import { y } from "./b"; export { y as x };`,
      "b.ts": `import { x } from "./a"; export { x as y };`,
      "use.ts": `import { x } from "./a"; (x as any).capture("cycle_local");`,
    });
    expect(events).toEqual([]);
  });

  it("terminates on circular type references", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `import { T } from "./b"; export declare const x: T;`,
      "b.ts": `import { x } from "./a"; export { x as T };`,
      "use.ts": `import { x } from "./a"; x.capture("cycle_type");`,
    });
    expect(events).toEqual([]);
  });

  it("matches when any one of several declarations of a symbol comes from the package", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `
        import { usePostHog } from "posthog-js/react";
        var ph = usePostHog();
        var ph: any;
        ph.capture("one_of_two_declarations");
      `,
    });
    expect(events).toEqual(["one_of_two_declarations"]);
  });

  it("follows type aliases and function or method return types", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `
        import { PostHog } from "posthog-js";
        type Client = PostHog;
        declare const viaAlias: Client;
        declare function make(): PostHog;
        declare const holder: { get(): PostHog };
        viaAlias.capture("via_alias");
        make().capture("via_return_type");
        const m = make(); m.capture("via_call_result");
        class K { client(): PostHog { return make(); } go() { this.client().capture("via_method_return"); } }
      `,
    });
    expect(events.sort()).toEqual(["via_alias", "via_call_result", "via_method_return", "via_return_type"]);
  });

  it("does not follow a return type from another package", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `
        import { Camera } from "camera-lib";
        declare function snap(): Camera;
        snap().capture("nope_return");
        class C {}
        declare const c: C;
        (c as any).capture("nope_class");
      `,
    });
    expect(events).toEqual([]);
  });
});

describe("sinks: remaining receiver cases", () => {
  const CAP = [{ callee: "capture", modules: ["posthog-js"] }];

  it("does not treat a namespace import of a local module as that module's default export", async () => {
    const { events } = await scan(CAP, {
      "client.ts": `import posthog from "posthog-js"; export default posthog;`,
      "a.ts": `import * as ns from "./client"; (ns as any).capture("nope_namespace_of_default");`,
    });
    expect(events).toEqual([]);
  });

  it("terminates on circular type aliases across modules", async () => {
    const { events } = await scan(CAP, {
      "a.ts": `import { B } from "./b"; export type A = B;`,
      "b.ts": `import { A } from "./a"; export type B = A;`,
      "use.ts": `import { A } from "./a"; declare const x: A; x.capture("cycle_aliases");`,
    });
    expect(events).toEqual([]);
  });

  it("matches window.posthog.capture({ event }) through the plain-name rule, without any import", async () => {
    const { events } = await scan(POSTHOG, {
      "a.ts": `declare const window: any; window.posthog.capture({ event: "global_object_event" });`,
    });
    expect(events).toEqual(["global_object_event"]);
  });
});

describe("sinks: projects with a wildcard `declare module \"*\"` (from Formbricks)", () => {
  const WILD = { "env.d.ts": `declare module "*";` };

  it("still follows an imported, typed client through a wrapper", async () => {
    const { events } = await scan(POSTHOG, {
      ...WILD,
      "lib/server.ts": `import { PostHog } from "posthog-node"; declare function mk(): PostHog | null; export const posthogServerClient: PostHog | null = mk();`,
      "lib/capture.ts": `import { posthogServerClient } from "./server"; export function capturePostHogEvent(d: string, eventName: string) { posthogServerClient?.capture({ distinctId: d, event: eventName }); }`,
      "use.ts": `import { capturePostHogEvent } from "./lib/capture"; capturePostHogEvent("u", "Wild Card: Event");`,
    });
    expect(events).toEqual(["Wild Card: Event"]);
  });

  it("still follows hooks, namespaces, qualified types, aliases and return types", async () => {
    const { events } = await scan(POSTHOG, {
      ...WILD,
      "a.ts": `
        import { usePostHog } from "posthog-js/react";
        import * as ns from "posthog-node";
        import { PostHog } from "posthog-node";
        type Client = PostHog;
        declare const qualified: ns.PostHog;
        declare const aliased: Client;
        declare function make(): PostHog;
        const ph = usePostHog();
        ph.capture("wild hook");
        qualified.capture({ distinctId: "u", event: "wild qualified" });
        aliased.capture({ distinctId: "u", event: "wild alias" });
        make().capture({ distinctId: "u", event: "wild return" });
      `,
    });
    expect(events.sort()).toEqual(["wild alias", "wild hook", "wild qualified", "wild return"]);
  });

  it("still rejects a client that is not from the package", async () => {
    const { events } = await scan(POSTHOG, {
      ...WILD,
      "a.ts": `import { Camera } from "camera-lib"; declare const cam: Camera; cam.capture({ event: "nope" } as any);`,
    });
    expect(events).toEqual([]);
  });
});

describe("sinks: segment preset", () => {
  const SEGMENT = [{ preset: "segment" }];

  it("detects analytics.track in analytics.js style, with props, window.analytics and optional chaining", async () => {
    const { events } = await scan(SEGMENT, {
      "a.ts": `
        declare const analytics: any;
        declare const window: any;
        analytics.track("Order Completed", { total: 5 });
        window.analytics.track("Checkout: Started");
        window.analytics?.track("Optional Chain Event");
      `,
    });
    expect(events.sort()).toEqual(["Checkout: Started", "Optional Chain Event", "Order Completed"]);
  });

  it("detects analytics-node's object form and ignores an object without event", async () => {
    const { events } = await scan(SEGMENT, {
      "a.ts": `
        import { Analytics } from "@segment/analytics-node";
        const client = new Analytics({ writeKey: "k" });
        client.track({ userId: "u", event: "Node Event", properties: {} });
        client.track({ userId: "u" } as any);
      `,
    });
    expect(events).toEqual(["Node Event"]);
  });

  it("detects a browser client created with `const [analytics] = await AnalyticsBrowser.load()`", async () => {
    const { events } = await scan(SEGMENT, {
      "a.ts": `
        import { AnalyticsBrowser } from "@segment/analytics-next";
        export async function f() {
          const [seg] = await AnalyticsBrowser.load({ writeKey: "k" });
          seg.track("Loaded Client: Click");
        }
        const buffered = AnalyticsBrowser.load({ writeKey: "k" });
        buffered.track("Buffered Client Event");
      `,
    });
    expect(events.sort()).toEqual(["Buffered Client Event", "Loaded Client: Click"]);
  });

  it.each(["@segment/analytics-next", "@segment/analytics-node", "@segment/analytics-react-native", "@segment/analytics.js-core", "analytics-node"])(
    "recognises a client coming from %s",
    async (mod) => {
      const { events } = await scan(SEGMENT, {
        "a.ts": `import { Client } from "${mod}"; const c = new (Client as any)(); c.track("from_segment_module");`,
      });
      expect(events).toEqual(["from_segment_module"]);
    },
  );

  it("does not match track on an unrelated client or another vendor's package", async () => {
    const { events } = await scan(SEGMENT, {
      "a.ts": `
        import { Tracker } from "other-lib";
        import { Client } from "@amplitude/analytics-node";
        const t = new (Tracker as any)(); t.track("nope_other");
        const c = new (Client as any)(); c.track("nope_amplitude");
        declare const app: any;
        app.track("nope_plain");
      `,
    });
    expect(events).toEqual([]);
  });

  it("forwards a spaced name through a wrapper", async () => {
    const { events } = await scan(SEGMENT, {
      "a.ts": `
        declare const analytics: any;
        export const track = (name: string) => analytics.track(name);
        track("Wrapped Segment: Event");
      `,
    });
    expect(events).toEqual(["Wrapped Segment: Event"]);
  });
});

describe("sinks: amplitude preset", () => {
  const AMP = [{ preset: "amplitude" }];

  it("detects amplitude.track and logEvent, as strings and as event_type objects", async () => {
    const { events } = await scan(AMP, {
      "a.ts": `
        import * as amplitude from "@amplitude/analytics-browser";
        amplitude.track("Button Clicked");
        amplitude.track({ event_type: "Object Form Event" });
        amplitude.logEvent("Legacy Log Event");
        amplitude.track({ user_id: "u" } as any);
      `,
    });
    expect(events.sort()).toEqual(["Button Clicked", "Legacy Log Event", "Object Form Event"]);
  });

  it("detects amplitude-js style instances, whatever the variable is called", async () => {
    const { events } = await scan(AMP, {
      "a.ts": `
        import amplitude from "amplitude-js";
        amplitude.getInstance().logEvent("From getInstance");
        const client = amplitude.createInstance();
        client.logEvent("From createInstance");
        const other = amplitude.getInstance();
        other.track("Other Var Track");
      `,
    });
    expect(events.sort()).toEqual(["From createInstance", "From getInstance", "Other Var Track"]);
  });

  it.each([
    "@amplitude/analytics-browser",
    "@amplitude/analytics-node",
    "@amplitude/analytics-react-native",
    "@amplitude/marketing-analytics-browser",
    "@amplitude/unified",
    "amplitude-js",
  ])("recognises a client coming from %s", async (mod) => {
    const { events } = await scan(AMP, {
      "a.ts": `import { client } from "${mod}"; (client as any).track("from_amplitude_module"); (client as any).logEvent("from_amplitude_log");`,
    });
    expect(events.sort()).toEqual(["from_amplitude_log", "from_amplitude_module"]);
  });

  it("does not match unrelated clients", async () => {
    const { events } = await scan(AMP, {
      "a.ts": `
        import { client } from "@segment/analytics-next";
        (client as any).track("nope_segment");
        (client as any).logEvent("nope_segment_log");
        declare const bus: any;
        bus.logEvent("nope_plain");
      `,
    });
    expect(events).toEqual([]);
  });
});

describe("sinks: ga4 preset and the `when` guard", () => {
  const GA4 = [{ preset: "ga4" }];

  it("detects gtag('event', name) and ignores every other gtag command", async () => {
    const { events } = await scan(GA4, {
      "a.ts": `
        declare function gtag(...args: unknown[]): void;
        declare const window: any;
        gtag("event", "purchase", { value: 5 });
        window.gtag("event", "Add To Cart: Click");
        window.gtag?.("event", "optional_call");
        gtag("config", "G-XXXX");
        gtag("set", "user_properties", {});
        gtag("js", new Date());
        gtag("event");
        gtag();
      `,
    });
    expect(events.sort()).toEqual(["Add To Cart: Click", "optional_call", "purchase"]);
  });

  it("accepts a no-substitution template literal and a cast guard, but not a variable guard", async () => {
    const { events } = await scan(GA4, {
      "a.ts": `
        declare function gtag(...args: unknown[]): void;
        declare const command: string;
        gtag(\`event\`, "from_template_guard");
        gtag("event" as string, "from_cast_guard");
        gtag(command, "nope_variable_guard");
        gtag("events", "nope_other_literal");
      `,
    });
    expect(events.sort()).toEqual(["from_cast_guard", "from_template_guard"]);
  });

  it("detects @next/third-parties sendGAEvent", async () => {
    const { events } = await scan(GA4, {
      "a.tsx": `
        import { sendGAEvent } from "@next/third-parties/google";
        sendGAEvent("event", "buttonClicked", { value: "xyz" });
        sendGAEvent("config", "nope");
      `,
    });
    expect(events).toEqual(["buttonClicked"]);
  });

  it("detects vue-gtag's this.$gtag.event", async () => {
    const { events } = await scan(GA4, {
      "a.ts": `class C { $gtag: any; go() { this.$gtag.event("vue gtag: event", { a: 1 }); } }`,
    });
    expect(events).toEqual(["vue gtag: event"]);
  });

  it("detects react-ga4 under any import name, string and object forms", async () => {
    const { events } = await scan(GA4, {
      "a.ts": `
        import ReactGA from "react-ga4";
        import ga from "react-ga4";
        ReactGA.event("react_ga_string", { a: 1 });
        ga.event({ category: "c", action: "react_ga_action" });
        ga.event({ category: "no action" } as any);
      `,
    });
    expect(events.sort()).toEqual(["react_ga_action", "react_ga_string"]);
  });

  it("does not match event() from another package", async () => {
    const { events } = await scan(GA4, {
      "a.ts": `import emitter from "events"; (emitter as any).event("nope"); declare const bus: any; bus.event("nope2");`,
    });
    expect(events).toEqual([]);
  });

  it("forwards gtag through a wrapper with a spaced name", async () => {
    const { events } = await scan(GA4, {
      "a.ts": `
        declare function gtag(...args: unknown[]): void;
        export const track = (name: string) => gtag("event", name);
        track("GA4 Wrapped: Event");
      `,
    });
    expect(events).toEqual(["GA4 Wrapped: Event"]);
  });

  it("combines all four presets in one config", async () => {
    const { events } = await scan(
      [{ preset: "posthog" }, { preset: "segment" }, { preset: "amplitude" }, { preset: "ga4" }],
      {
        "a.ts": `
          import posthog from "posthog-js";
          import * as amplitude from "@amplitude/analytics-browser";
          declare const analytics: any;
          declare function gtag(...a: unknown[]): void;
          posthog.capture("ph: event");
          analytics.track("seg: event");
          amplitude.track("amp: event");
          gtag("event", "ga: event");
        `,
      },
    );
    expect(events.sort()).toEqual(["amp: event", "ga: event", "ph: event", "seg: event"]);
  });
});

describe("sinks: `when` configuration", () => {
  it("is validated and copied into the resolved rule", () => {
    const warnings: string[] = [];
    const rules = resolveSinkRules(
      [
        { callee: "a.b", when: { arg: 0, equals: "event" } },
        { callee: "bad.one", when: { arg: -1, equals: "event" } },
        { callee: "bad.two", when: { arg: 1.5, equals: "event" } },
        { callee: "bad.three", when: { arg: 0, equals: "" } },
        { callee: "bad.four", when: { arg: 0, equals: 5 as unknown as string } },
        { callee: "bad.five", when: null as unknown as { arg: number; equals: string } },
        { callee: "bad.six", when: {} as { arg: number; equals: string } },
      ],
      (m) => warnings.push(m),
    );
    expect(rules).toEqual([{ callee: "a.b", nameArg: 0, when: { arg: 0, equals: "event" } }]);
    expect(warnings).toEqual(
      ["bad.one", "bad.two", "bad.three", "bad.four", "bad.five", "bad.six"].map(
        (c) => `Eventra: sinks rule "${c}" has an invalid "when" - skipped.`,
      ),
    );
  });

  it("works on a custom rule", async () => {
    const { events } = await scan([{ callee: "dl.push", nameArg: 1, when: { arg: 0, equals: "event" } }], {
      "a.ts": `declare const dl: any; dl.push("event", "custom_guarded"); dl.push("set", "nope"); dl.push();`,
    });
    expect(events).toEqual(["custom_guarded"]);
  });

  it("is kept through normalizeConfig", () => {
    const cfg = normalizeConfig({ sinks: [{ callee: "a.b", when: { arg: 0, equals: "event" } }] });
    expect(cfg.sinks).toEqual([{ callee: "a.b", when: { arg: 0, equals: "event" } }]);
  });
});

describe("sinks: preset text rules work without any import (globals and CDN snippets)", () => {
  it("segment: analytics.track with an object, on a global", async () => {
    const { events } = await scan([{ preset: "segment" }], {
      "a.ts": `declare const analytics: any; analytics.track({ userId: "u", event: "Global Segment Object" });`,
    });
    expect(events).toEqual(["Global Segment Object"]);
  });

  it("amplitude: amplitude.track and amplitude.logEvent on a global, string and object forms", async () => {
    const { events } = await scan([{ preset: "amplitude" }], {
      "a.ts": `
        declare const amplitude: any;
        amplitude.track("Global Track String");
        amplitude.track({ event_type: "Global Track Object" });
        amplitude.logEvent("Global Log String");
        amplitude.logEvent({ event_type: "Global Log Object" });
      `,
    });
    expect(events.sort()).toEqual(["Global Log Object", "Global Log String", "Global Track Object", "Global Track String"]);
  });

  it("amplitude: object forms through a client imported from a package under another name", async () => {
    const { events } = await scan([{ preset: "amplitude" }], {
      "a.ts": `
        import { client } from "@amplitude/analytics-node";
        (client as any).track({ event_type: "Client Track Object" });
        (client as any).logEvent({ event_type: "Client Log Object" });
      `,
    });
    expect(events.sort()).toEqual(["Client Log Object", "Client Track Object"]);
  });
});

describe("sinks: current packages and bare calls from a module", () => {
  it("recognises usePostHog from @posthog/react, the package that now ships the React hooks", async () => {
    const { events } = await scan([{ preset: "posthog" }], {
      "a.tsx": `
        import { usePostHog } from "@posthog/react";
        export function Button() { const posthog = usePostHog(); const ph = usePostHog(); ph.capture("Hook From New Package"); return null; }
      `,
    });
    expect(events).toEqual(["Hook From New Package"]);
  });

  it("does not treat a deprecated or unrelated posthog-named package as PostHog", async () => {
    const { events } = await scan([{ preset: "posthog" }], {
      "a.ts": `import { usePostHog } from "@posthog/nextjs"; const ph = usePostHog(); (ph as any).capture("nope");`,
    });
    expect(events).toEqual([]);
  });

  it("vets a bare call by where the called name comes from", async () => {
    const { events } = await scan([{ callee: "track", modules: ["lib-x"] }], {
      "a.ts": `
        import { track } from "lib-x";
        import { track as other } from "lib-y";
        declare function localTrack(n: string): void;
        track("From Module Bare");
        other("nope_other_module");
        localTrack("nope_local");
      `,
    });
    expect(events).toEqual(["From Module Bare"]);
  });

  it("vue-gtag: a named event import and a destructured useGtag(), but not the same name from another library", async () => {
    const { events } = await scan([{ preset: "ga4" }], {
      "named.ts": `
        import { event } from "vue-gtag";
        event("vue named import", { a: 1 });
      `,
      "composable.ts": `
        import { useGtag } from "vue-gtag";
        const { event } = useGtag();
        event("vue destructured");
      `,
      "other.ts": `
        import { event } from "events-lib";
        event("nope_other_lib");
      `,
    });
    expect(events.sort()).toEqual(["vue destructured", "vue named import"]);
  });

  it("nuxt-gtag: useTrackEvent and gtag from useGtag, ignoring other gtag commands", async () => {
    const { events } = await scan([{ preset: "ga4" }], {
      "a.ts": `
        declare function useTrackEvent(...a: unknown[]): void;
        declare function useGtag(): { gtag: (...a: unknown[]) => void };
        useTrackEvent("nuxt login", { method: "Google" });
        const { gtag } = useGtag();
        gtag("event", "nuxt gtag event");
        gtag("consent", "update", {});
      `,
    });
    expect(events.sort()).toEqual(["nuxt gtag event", "nuxt login"]);
  });

  it("amplitude marketing analytics and unified packages are recognised", async () => {
    const { events } = await scan([{ preset: "amplitude" }], {
      "a.ts": `
        import { client } from "@amplitude/unified";
        import { client as marketing } from "@amplitude/marketing-analytics-browser";
        (client as any).track("Unified Client");
        (marketing as any).track("Marketing Client");
      `,
    });
    expect(events.sort()).toEqual(["Marketing Client", "Unified Client"]);
  });
});

describe("sinks: hand-edited config with wrong types", () => {
  it("skips a rule whose callee is not a string, instead of crashing", () => {
    const warnings: string[] = [];
    const bad = [5, null, {}, [], true].map((callee) => ({ callee }) as unknown as SinkRuleConfig);
    expect(resolveSinkRules(bad, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(5);
    expect(warnings.every((w) => w.includes('needs a "preset" or a dotted "callee"'))).toBe(true);
  });

  it("skips a rule whose preset is not a string", () => {
    const warnings: string[] = [];
    const bad = [5, null, {}, ["posthog"]].map((preset) => ({ preset }) as unknown as SinkRuleConfig);
    expect(resolveSinkRules(bad, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(4);
  });

  it("skips a rule whose nameProperty is not a string", () => {
    const warnings: string[] = [];
    const rules = [5, {}, true, ["event"]].map((nameProperty) => ({ callee: "a.b", nameProperty }) as unknown as SinkRuleConfig);
    expect(resolveSinkRules(rules, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toEqual(Array(4).fill('Eventra: sinks rule "a.b" has an invalid "nameProperty" - skipped.'));
  });

  it("skips a rule whose modules is not a list of non-empty strings", () => {
    const warnings: string[] = [];
    const bad = ["posthog-js", {}, 5, [5], [""], ["ok", null], [["nested"]]].map(
      (modules) => ({ callee: "a.b", modules }) as unknown as SinkRuleConfig,
    );
    expect(resolveSinkRules(bad, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toEqual(Array(7).fill('Eventra: sinks rule "a.b" has an invalid "modules" - skipped.'));
  });

  it("skips a rule whose nameArg is not a number", () => {
    const rules = ["1", {}, true, [0]].map((nameArg) => ({ callee: "a.b", nameArg }) as unknown as SinkRuleConfig);
    expect(resolveSinkRules(rules, () => {})).toEqual([]);
  });

  it("treats a null nameArg like an absent one", () => {
    const rule = { callee: "a.b", nameArg: null } as unknown as SinkRuleConfig;
    expect(resolveSinkRules([rule], () => {})).toEqual([{ callee: "a.b", nameArg: 0 }]);
  });

  it("keeps an empty modules list or empty nameProperty as 'not set'", () => {
    expect(resolveSinkRules([{ callee: "a.b", modules: [], nameProperty: "" }], () => {})).toEqual([{ callee: "a.b", nameArg: 0 }]);
  });

  it("does not crash the registry when the whole config is full of garbage", async () => {
    const warnings: string[] = [];
    const registry = createBuiltinPluginRegistry();
    registerConfiguredSinks(
      registry,
      [{ callee: 5 }, { modules: "x", callee: "a.b" }, { preset: {} }] as unknown as SinkRuleConfig[],
      (m) => warnings.push(m),
    );
    expect(warnings).toHaveLength(3);
    expect(registry.getSinkDetectors().map((d) => d.name)).toEqual(["eventra-sdk"]);
  });
});
