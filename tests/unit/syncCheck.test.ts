import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  scan: null as null | {
    events: string[];
    wrappers: string[];
    skipped: Array<{ file: string; reason: string }>;
    ignored?: Array<{ file: string; reason: string }>;
    syntaxErrors?: Array<{ file: string; reason: string }>;
    rejected?: Array<Record<string, unknown>>;
    notes?: Array<{ file: string; reason: string }>;
    dynamic?: Array<Record<string, unknown>>;
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
      getAllDynamicOccurrences: () => state.scan!.dynamic ?? [],
      getAllRejectedNames: () => state.scan!.rejected ?? [],
    },
    plugins: { runDynamicEventReporters: async () => {}, attributeToSources: <T>(items: T[]) => items },
    skipped: state.scan!.skipped,
    ignored: state.scan!.ignored ?? [],
    syntaxErrors: state.scan!.syntaxErrors ?? [],
    notes: state.scan!.notes ?? [],
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

  it("lists ignored (oversized) files without keeping known events, and fails --strict on them", async () => {
    state.scan!.ignored = [{ file: "/p/vendor.min.js", reason: "file is larger than 2 MB" }];
    await sync({ strict: true });

    // not a skip: the stale event is pruned, but a strict run does not call the scan complete
    expect(state.saved[0].events).toEqual(["kept.event", "new.event"]);
    expect(printed(err)).toContain("Ignored 1 file (not analysed):");
    expect(printed(err)).toContain("vendor.min.js: file is larger than 2 MB");
    expect(printed(err)).not.toContain("Skipped");
    expect(process.exitCode).toBe(1);
  });

  it("--strict exits non-zero only when something was skipped", async () => {
    await sync({ strict: true });
    expect(process.exitCode).toBeUndefined();

    state.scan!.skipped = SKIP;
    await sync({ strict: true });
    expect(process.exitCode).toBe(1);
  });
});

const REJECTED = [
  { fileName: "/p/src/a.ts", line: 7, character: 0, calleeText: "sdk.track", callText: "", resolvedValues: ["x"], name: "bad\tname", reason: "the name has characters other than letters" },
];

describe("notes after a scan", () => {
  it("sync lists files with syntax errors and event names it cannot accept, and --strict fails on them", async () => {
    state.scan!.syntaxErrors = [{ file: "/p/src/broken.ts", reason: "line 3: ';' expected." }];
    state.scan!.rejected = REJECTED;
    await sync({ strict: true });

    expect(printed(err)).toContain("Syntax errors in 1 file (events after the error may be missed):");
    expect(printed(err)).toContain("src/broken.ts: line 3: ';' expected.");
    expect(printed(err)).toContain('Skipped 1 event name the CLI cannot accept:');
    expect(printed(err)).toContain('src/a.ts:7 "bad\\tname": the name has characters other than letters');
    expect(state.saved[0].events).toEqual(["kept.event", "new.event"]);
    expect(printed(err)).toContain("The scan was not clean: 1 file with a syntax error, 1 event name the CLI cannot accept.");
    expect(process.exitCode).toBe(1);
  });

  it("sync without --strict reports a clean scan as such and does not fail on notes", async () => {
    state.scan!.syntaxErrors = [{ file: "/p/src/broken.ts", reason: "line 3: ';' expected." }];
    await sync();
    expect(process.exitCode).toBeUndefined();

    err.mockClear();
    state.scan!.syntaxErrors = [];
    await sync({ strict: true });
    expect(printed(err)).not.toContain("not clean");
    expect(process.exitCode).toBeUndefined();
  });

  it("check prints them in a plain run and with --fix, and says nothing when there are none", async () => {
    await check({});
    expect(printed(err)).not.toContain("Syntax errors");
    expect(printed(err)).not.toContain("cannot accept");

    state.scan!.syntaxErrors = [{ file: "/p/src/broken.ts", reason: "line 3: ';' expected." }];
    state.scan!.rejected = REJECTED;
    err.mockClear();
    await check({});
    expect(printed(err)).toContain("src/broken.ts: line 3");
    expect(printed(err)).toContain('"bad\\tname"');

    err.mockClear();
    await check({ fix: true, strict: true });
    expect(printed(err)).toContain("src/broken.ts: line 3");
    expect(printed(err)).toContain('"bad\\tname"');
    expect(process.exitCode).toBe(1);
  });
});

const DYNAMIC = (resolvedValues: string[], extra: Record<string, unknown> = {}) => ({
  fileName: "/p/src/d.ts", line: 2, character: 0, calleeText: "track", callText: "track(x)", resolvedValues, ...extra,
});

describe("notes from plugins", () => {
  const NOTES = [{ file: "/p/src/a.component.html", reason: "[event] on <button> is a property binding" }];

  it("sync and check print them and never let them change the result", async () => {
    state.scan!.notes = NOTES;
    await sync({ strict: true });
    expect(printed(err)).toContain("Notes from plugins on 1 file:");
    expect(printed(err)).toContain("src/a.component.html: [event] on <button> is a property binding");
    expect(process.exitCode).toBeUndefined();

    state.config!.events = ["kept.event", "new.event"];
    state.config!.functionWrappers = [];
    err.mockClear();
    await check({ strict: true });
    expect(printed(err)).toContain("Notes from plugins on 1 file:");
    expect(printed(log)).toContain("All good");
    expect(exit).not.toHaveBeenCalled();

    err.mockClear();
    await check({ fix: true, strict: true });
    expect(printed(err)).toContain("Notes from plugins on 1 file:");
  });
});

describe("check: honest result", () => {
  beforeEach(() => {
    state.config!.events = ["kept.event", "new.event"];
    state.config!.functionWrappers = [];
  });

  it("says All good only for a clean scan", async () => {
    await check({ strict: true });
    expect(printed(log)).toContain("All good");
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not say All good when names are dynamic, and points at --strict", async () => {
    state.scan!.dynamic = [DYNAMIC([])];
    await check({});
    expect(printed(log)).toContain("No drift, but the scan was not clean: 1 dynamic event name.");
    expect(printed(log)).not.toContain("All good");
    expect(printed(err)).toContain("Use --strict");
    expect(exit).not.toHaveBeenCalled();
  });

  it("--strict fails on an unresolved dynamic name, but a name with resolved values is neither noted nor failed", async () => {
    state.scan!.dynamic = [DYNAMIC([])];
    await check({ strict: true });
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockClear();
    log.mockClear();
    state.scan!.dynamic = [DYNAMIC(["a", "b"])];
    await check({ strict: true });
    expect(exit).not.toHaveBeenCalled();
    expect(printed(log)).toContain("All good");
  });

  it("ignores generated copies of a call and does not count them", async () => {
    state.scan!.dynamic = [DYNAMIC([], { inGeneratedCode: true })];
    await check({ strict: true });
    expect(printed(log)).toContain("All good");
  });

  it("--strict fails on syntax errors and rejected names, and on oversized files", async () => {
    state.scan!.syntaxErrors = [{ file: "/p/src/broken.ts", reason: "line 3: ';' expected." }];
    await check({ strict: true });
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockClear();
    state.scan!.syntaxErrors = [];
    state.scan!.ignored = [{ file: "/p/vendor.min.js", reason: "file is larger than 2 MB" }];
    await check({ strict: true });
    expect(printed(log)).toContain("1 file over the size limit");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("--fix with --strict fails on dynamic names and says the scan was not clean", async () => {
    state.scan!.dynamic = [DYNAMIC([])];
    await check({ fix: true, strict: true });
    expect(process.exitCode).toBe(1);
    expect(printed(err)).toContain("The scan was not clean: 1 dynamic event name.");
  });

  it("declared dynamicEvents acknowledge the dynamic names: no note, and --strict passes", async () => {
    state.config!.dynamicEvents = ["declared.one"];
    state.scan!.dynamic = [DYNAMIC([])];
    await check({ strict: true });
    expect(printed(log)).toContain("All good");
    expect(exit).not.toHaveBeenCalled();
  });

  it("an empty or unusable dynamicEvents acknowledges nothing", async () => {
    state.config!.dynamicEvents = ["", 5, "\t"];
    state.scan!.dynamic = [DYNAMIC([])];
    await check({ strict: true });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("names a drift and an unclean scan together", async () => {
    state.config!.events = ["kept.event"];
    state.scan!.skipped = SKIP;
    await check({});
    expect(printed(log)).toContain("Drift found, and the scan was not clean: 1 skipped file.");
    expect(exit).toHaveBeenCalledWith(1);
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
    expect(printed(log)).not.toContain("All good");
    expect(printed(log)).toContain("No drift, but the scan was not clean: 1 skipped file.");
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

  it("an ignored (oversized) file does not hide removed events, and trips --strict", async () => {
    state.scan!.ignored = [{ file: "/p/vendor.min.js", reason: "file is larger than 2 MB" }];
    await check({ strict: true });

    expect(printed(log)).toContain("- old.event");
    expect(printed(err)).toContain("Ignored 1 file (not analysed):");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("an ignored (oversized) file fails --strict even when the events match", async () => {
    state.scan!.ignored = [{ file: "/p/vendor.min.js", reason: "file is larger than 2 MB" }];
    state.config!.events = ["kept.event", "new.event"];
    await check({ strict: true });

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("--fix reports ignored files and replaces events", async () => {
    state.scan!.ignored = [{ file: "/p/vendor.min.js", reason: "file is larger than 2 MB" }];
    await check({ fix: true, strict: true });

    expect(state.saved[0].events).toEqual(["kept.event", "new.event"]);
    expect(printed(err)).toContain("vendor.min.js");
    expect(process.exitCode).toBe(1);
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
