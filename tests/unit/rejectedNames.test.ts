import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM, eventNameRejection, normalizeEventName } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";
const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: { include: ["**/*.{ts,tsx}"], exclude: [] },
};
const HEAD = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst sdk = new Eventra({ apiKey: "k" });\n`;

async function scan(source: string, file = "a.ts") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rejected-"));
  try {
    const engine = new EventraEngine(root);
    engine.beginPreload();
    await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
    const abs = path.join(root, file);
    fs.writeFileSync(abs, source);
    await engine.preloadFile(abs, source);
    engine.endPreload();
    await engine.runFullAnalysis([SDK_TYPES, abs], CONFIG);
    return { events: engine.getAllEvents(), rejected: engine.getAllRejectedNames() };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("eventNameRejection", () => {
  it("gives the reason an event name cannot be used, and null for one that can", () => {
    expect(eventNameRejection("checkout.cta")).toBeNull();
    expect(eventNameRejection("App: Sign Up $x/y-z_1")).toBeNull();
    expect(eventNameRejection("a".repeat(64))).toBeNull();
    expect(eventNameRejection("   ")).toBe("the name is empty");
    expect(eventNameRejection("")).toBe("the name is empty");
    expect(eventNameRejection("a".repeat(500))).toBeNull();
    expect(eventNameRejection("rocket 🚀")).toBeNull();
    expect(eventNameRejection("Оформление заказа")).toBeNull();
    expect(eventNameRejection("a\tb")).toBe("the name has control characters such as a tab or a line break");
    expect(eventNameRejection("a\nb")).toMatch(/control characters/);
    expect(eventNameRejection("a\u0000b")).toMatch(/control characters/);
  });

  it("cuts a long name to 64 characters like the SDK does", () => {
    expect(normalizeEventName("a".repeat(65))).toBe("a".repeat(64));
    expect(normalizeEventName("  " + "b".repeat(70) + "  ")).toBe("b".repeat(64));
    expect(normalizeEventName("🚀 launch")).toBe("🚀 launch");
  });

  it("stays in step with normalizeEventName", () => {
    for (const value of ["ok", "  padded  ", "", "🚀", "a".repeat(65), "a\nb"]) {
      expect(normalizeEventName(value) === null).toBe(eventNameRejection(value) !== null);
    }
  });
});

describe("rejected event names", () => {
  it("records a plain name the CLI cannot accept, with where it is and why, and keeps the valid ones", async () => {
    const { events, rejected } = await scan(
      `${HEAD}sdk.track("good.one");\nsdk.track("tab\\there");\nsdk.track("rocket 🚀");\nsdk.track("${"x".repeat(70)}");\nsdk.track("");\n`,
    );
    expect(events).toEqual(["good.one", "rocket 🚀", "x".repeat(64)]);
    expect(rejected.map((r) => [r.line, r.name, r.reason])).toEqual([
      [4, "tab\there", "the name has control characters such as a tab or a line break"],
      [7, "", "the name is empty"],
    ]);
    expect(rejected[0].calleeText).toBe("sdk.track");
    expect(rejected[0].fileName).toMatch(/a\.ts$/);
  });

  it("shortens a long rejected name in the note, with an ellipsis", async () => {
    const { rejected } = await scan(`${HEAD}sdk.track("${"x".repeat(70)}\\ty");\n`);
    expect(rejected.map((r) => r.name)).toEqual([`${"x".repeat(60)}…`]);
  });

  it("records the call site of a wrapper that passes a bad literal on", async () => {
    const { events, rejected } = await scan(
      `${HEAD}function t(name: string) { sdk.track(name); }\nt("ok.name");\nt("bad\\tname");\n`,
    );
    expect(events).toEqual(["ok.name"]);
    expect(rejected.map((r) => [r.line, r.name, r.calleeText])).toEqual([[5, "bad\tname", "t"]]);
  });

  it("records a bad prop value of a component", async () => {
    const { events, rejected } = await scan(
      `${HEAD}function B({ n }: { n: string }) { return <i onClick={() => sdk.track(n)} />; }\nexport const P = () => <><B n="fine" /><B n={"no\\tway"} /></>;\n`,
      "a.tsx",
    );
    expect(events).toEqual(["fine"]);
    expect(rejected.map((r) => r.name)).toEqual(["no\tway"]);
  });

  it("does not record a name that is dynamic, or one that is fine", async () => {
    const { rejected } = await scan(`${HEAD}export const f = (n: string) => sdk.track(n);\nsdk.track("fine");\n`);
    expect(rejected).toEqual([]);
  });

  it("lists them in file and line order", async () => {
    const { rejected } = await scan(`${HEAD}sdk.track("b\\tc");\nsdk.track("a\\tc");\n`);
    expect(rejected.map((r) => r.name)).toEqual(["b\tc", "a\tc"]);
    expect(rejected.map((r) => r.line)).toEqual([3, 4]);
  });
});
