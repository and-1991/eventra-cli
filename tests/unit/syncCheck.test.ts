import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  scan: null as null | {
    events: string[];
    wrappers: string[];
    skipped: Array<{ file: string; reason: string }>;
    ignored?: Array<{ file: string; reason: string }>;
  },
  saved: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/config/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config")>();
  return {
    ...actual,
    requireConfig: async () => {
      if (!state.config) {
        process.exitCode = 1;
        return null;
      }
      return state.config;
    },
    saveConfig: async (config: Record<string, unknown>) => {
      state.saved.push(config);
    },
  };
});

vi.mock("../../src/core/projectScanner", () => ({
  scanProject: async () => ({
    engine: {
      getAllEvents: () => state.scan!.events,
      getAllFunctionWrappers: () => state.scan!.wrappers,
      getAllDynamicOccurrences: () => [],
    },
    plugins: { runDynamicEventReporters: async () => {} },
    skipped: state.scan!.skipped,
    ignored: state.scan!.ignored ?? [],
    files: [],
    results: new Map(),
  }),
}));

import { check } from "../../src/cli/check";
import { sync } from "../../src/cli/sync";

const BASE = {
  apiKey: "",
  endpoint: "",
  events: ["old.event", "kept.event"],
  functionWrappers: [{ name: "oldWrapper" }],
  sync: { include: ["**/*.ts"], exclude: [] },
};

const SKIP = [{ file: "/p/src/Bad.vue", reason: "Element is missing end tag." }];

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.config = { ...BASE };
  state.scan = { events: ["kept.event", "new.event"], wrappers: [], skipped: [] };
  state.saved.length = 0;
  process.exitCode = undefined;
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const printed = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0])).join("\n");

describe("sync", () => {
  it("fails with exit code 1 when there is no config", async () => {
    state.config = null;
    await sync();
    expect(process.exitCode).toBe(1);
    expect(state.saved).toHaveLength(0);
  });

  it("replaces events with the scan result when nothing was skipped, and uses the singular", async () => {
    state.scan = { events: ["only.one"], wrappers: ["w"], skipped: [] };
    await sync();
    expect(state.saved[0].events).toEqual(["only.one"]);
    expect(printed(log)).toContain("Found 1 event, 1 function wrapper");
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps previously known events when a file was skipped, and reports it once", async () => {
    state.scan!.skipped = SKIP;
    await sync();

    expect(state.saved[0].events).toEqual(["kept.event", "new.event", "old.event"]);
    expect(state.saved[0].functionWrappers).toEqual([{ name: "oldWrapper" }]);
    expect(printed(err)).toContain("src/Bad.vue: Element is missing end tag.");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports the number of events that were saved, not only the ones this scan found", async () => {
    state.scan!.skipped = SKIP;
    await sync();
    // 3 known (old, kept, new) after merging with the 2 found
    expect(printed(log)).toContain("Found 3 events, 1 function wrapper");
  });

  it("lists ignored (oversized) files without keeping known events and without failing --strict", async () => {
    state.scan!.ignored = [{ file: "/p/vendor.min.js", reason: "file is larger than 2 MB" }];
    await sync({ strict: true });

    // not a skip: the stale event is pruned and strict mode stays green
    expect(state.saved[0].events).toEqual(["kept.event", "new.event"]);
    expect(printed(err)).toContain("Ignored 1 file (not analysed):");
    expect(printed(err)).toContain("vendor.min.js: file is larger than 2 MB");
    expect(printed(err)).not.toContain("Skipped");
    expect(process.exitCode).toBeUndefined();
  });

  it("--strict exits non-zero only when something was skipped", async () => {
    await sync({ strict: true });
    expect(process.exitCode).toBeUndefined();

    state.scan!.skipped = SKIP;
    await sync({ strict: true });
    expect(process.exitCode).toBe(1);
  });
});

describe("check", () => {
  it("fails with exit code 1 when there is no config", async () => {
    state.config = null;
    await check({});
    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("reports a removed event as drift when the scan is complete", async () => {
    await check({});
    expect(printed(log)).toContain("- old.event");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not call a known event removed when a file was skipped, and says so", async () => {
    state.config!.events = ["old.event", "kept.event", "new.event"];
    state.config!.functionWrappers = [];
    state.scan!.skipped = SKIP;
    await check({});

    expect(printed(log)).not.toContain("- old.event");
    expect(printed(err)).toContain("src/Bad.vue");
    expect(printed(err)).toContain("1 known entry could not be verified");
    expect(exit).not.toHaveBeenCalled();
    expect(printed(log)).toContain("All good");
  });

  it("--strict fails the check when a file was skipped even without drift", async () => {
    state.config!.events = ["kept.event", "new.event"];
    state.scan!.skipped = SKIP;
    await check({ strict: true });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("--fix keeps known events while files are skipped", async () => {
    state.scan!.skipped = SKIP;
    await check({ fix: true, strict: true });

    expect(state.saved[0].events).toEqual(["kept.event", "new.event", "old.event"]);
    expect(process.exitCode).toBe(1);
  });

  it("an ignored (oversized) file neither hides removed events nor trips --strict", async () => {
    state.scan!.ignored = [{ file: "/p/vendor.min.js", reason: "file is larger than 2 MB" }];
    await check({ strict: true });

    expect(printed(log)).toContain("- old.event");
    expect(printed(err)).toContain("Ignored 1 file (not analysed):");
    expect(exit).toHaveBeenCalledWith(1); // because of the drift, not because of the ignored file
  });

  it("--fix reports ignored files and replaces events", async () => {
    state.scan!.ignored = [{ file: "/p/vendor.min.js", reason: "file is larger than 2 MB" }];
    await check({ fix: true, strict: true });

    expect(state.saved[0].events).toEqual(["kept.event", "new.event"]);
    expect(printed(err)).toContain("vendor.min.js");
    expect(process.exitCode).toBeUndefined();
  });

  it("--fix replaces events when the scan is complete", async () => {
    await check({ fix: true });
    expect(state.saved[0].events).toEqual(["kept.event", "new.event"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("pluralises the unverified entries", async () => {
    state.config!.events = ["a", "b", "kept.event", "new.event"];
    state.config!.functionWrappers = [];
    state.scan!.skipped = SKIP;
    await check({});
    expect(printed(err)).toContain("2 known entries could not be verified");
  });

  it("lists added wrappers and tolerates a config without events or wrappers", async () => {
    state.config = { apiKey: "", endpoint: "", sync: { include: [], exclude: [] } };
    state.scan = { events: ["e"], wrappers: ["newWrapper"], skipped: [] };
    await check({});

    expect(printed(log)).toContain("+ e");
    expect(printed(log)).toContain("+ newWrapper");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
