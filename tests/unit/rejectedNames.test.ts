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
    expect(eventNameRejection("a".repeat(65))).toBe("the name is longer than 64 characters");
    expect(eventNameRejection("  " + "a".repeat(64) + "  ")).toBeNull();
    expect(eventNameRejection("rocket 🚀")).toBe("the name has characters other than letters, digits and $ : _ . / - and space");
    expect(eventNameRejection("a\tb")).toMatch(/characters other than/);
  });

  it("stays in step with normalizeEventName", () => {
    for (const value of ["ok", "  padded  ", "", "🚀", "a".repeat(65), "a\nb"]) {
      expect(normalizeEventName(value)).toBe(eventNameRejection(value) === null ? value.trim() : null);
    }
  });
});

describe("rejected event names", () => {
  it("records a plain name the CLI cannot accept, with where it is and why, and keeps the valid ones", async () => {
    const { events, rejected } = await scan(
      `${HEAD}sdk.track("good.one");\nsdk.track("rocket 🚀");\nsdk.track("${"x".repeat(70)}");\nsdk.track("");\n`,
    );
    expect(events).toEqual(["good.one"]);
    expect(rejected.map((r) => [r.line, r.name, r.reason])).toEqual([
      [4, "rocket 🚀", "the name has characters other than letters, digits and $ : _ . / - and space"],
      [5, `${"x".repeat(60)}…`, "the name is longer than 64 characters"],
      [6, "", "the name is empty"],
    ]);
    expect(rejected[0].calleeText).toBe("sdk.track");
    expect(rejected[0].fileName).toMatch(/a\.ts$/);
  });

  it("records the call site of a wrapper that passes a bad literal on", async () => {
    const { events, rejected } = await scan(
      `${HEAD}function t(name: string) { sdk.track(name); }\nt("ok.name");\nt("bad name!");\n`,
    );
    expect(events).toEqual(["ok.name"]);
    expect(rejected.map((r) => [r.line, r.name, r.calleeText])).toEqual([[5, "bad name!", "t"]]);
  });

  it("records a bad prop value of a component", async () => {
    const { events, rejected } = await scan(
      `${HEAD}function B({ n }: { n: string }) { return <i onClick={() => sdk.track(n)} />; }\nexport const P = () => <><B n="fine" /><B n="no way!" /></>;\n`,
      "a.tsx",
    );
    expect(events).toEqual(["fine"]);
    expect(rejected.map((r) => r.name)).toEqual(["no way!"]);
  });

  it("does not record a name that is dynamic, or one that is fine", async () => {
    const { rejected } = await scan(`${HEAD}export const f = (n: string) => sdk.track(n);\nsdk.track("fine");\n`);
    expect(rejected).toEqual([]);
  });

  it("lists them in file and line order", async () => {
    const { rejected } = await scan(`${HEAD}sdk.track("b!");\nsdk.track("a!");\n`);
    expect(rejected.map((r) => r.name)).toEqual(["b!", "a!"]);
    expect(rejected.map((r) => r.line)).toEqual([3, 4]);
  });
});
