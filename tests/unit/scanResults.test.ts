import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConfigFromScan, persistScanResults } from "../../src/core/scanResults";
import { CONFIG_NAME } from "../../src/config/config";
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

describe("persistScanResults", () => {
  const originalCwd = process.cwd();
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-scanresults-"));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  it("builds the config from the engine and writes it to eventra.json", async () => {
    const engine = makeEngineStub(["b.event", "a.event"], ["wrapperB"]);

    await persistScanResults(BASE, engine);

    const written = await fs.readJSON(path.join(tmp, CONFIG_NAME));
    // saveConfig normalizes: events sorted, apiKey/endpoint preserved from BASE.
    expect(written.events).toEqual(["a.event", "b.event"]);
    expect(written.functionWrappers).toEqual([{ name: "wrapperB" }]);
    expect(written.apiKey).toBe("secret");
    expect(written.endpoint).toBe("https://api.example.com");
  });
});
