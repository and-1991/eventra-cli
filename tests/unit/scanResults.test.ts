import { describe, expect, it } from "vitest";
import { buildConfigFromScan } from "../../src/core/scanResults";
import { EventraConfig } from "../../src/types";
import { EventraEngine } from "../../src/core/EventraEngine";

// minimal stub satisfying the EventraEngine surface used by buildConfigFromScan
function makeEngineStub(
  events: string[],
  wrappers: string[],
): EventraEngine {
  return {
    getAllEvents: () => events,
    getAllFunctionWrappers: () => wrappers,
  } as unknown as EventraEngine;
}

const BASE: EventraConfig = {
  apiKey: "secret",
  endpoint: "https://api.example.com",
  events: ["stale"],
  functionWrappers: [{ name: "oldWrapper" }],
  sync: {
    include: ["src/**/*.ts"],
    exclude: ["dist"],
  },
};

describe("buildConfigFromScan", () => {
  it("replaces events and wrappers with engine output", () => {
    const engine = makeEngineStub(["new.a", "new.b"], ["wrapperA"]);
    const out = buildConfigFromScan(BASE, engine);

    expect(out.events).toEqual(["new.a", "new.b"]);
    expect(out.functionWrappers).toEqual([{ name: "wrapperA" }]);
  });

  it("preserves apiKey, endpoint, and sync settings", () => {
    const engine = makeEngineStub([], []);
    const out = buildConfigFromScan(BASE, engine);

    expect(out.apiKey).toBe("secret");
    expect(out.endpoint).toBe("https://api.example.com");
    expect(out.sync.include).toEqual(["src/**/*.ts"]);
    expect(out.sync.exclude).toEqual(["dist"]);
  });

  it("handles empty engine output cleanly", () => {
    const engine = makeEngineStub([], []);
    const out = buildConfigFromScan(BASE, engine);
    expect(out.events).toEqual([]);
    expect(out.functionWrappers).toEqual([]);
  });
});
