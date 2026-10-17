import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerConsoleDynamicEventReporterPlugin } from "../../src/plugin/builtins/consoleDynamicEventReporter";
import { PluginRegistry } from "../../src/plugin/registry";
import type { DynamicOccurrence } from "../../src/analysis/shared/dynamicOccurrence";

// The working directory is faked (no process.chdir), so these run in any worker pool.
const CWD = "/work/proj";

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(process, "cwd").mockReturnValue(CWD);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function occurrence(overrides: Partial<DynamicOccurrence> = {}): DynamicOccurrence {
  return {
    fileName: `${CWD}/src/a.ts`,
    line: 10,
    character: 4,
    calleeText: "sdk.track",
    callText: "sdk.track(name)",
    resolvedValues: [],
    ...overrides,
  };
}

async function report(...occurrences: DynamicOccurrence[]): Promise<void> {
  const registry = new PluginRegistry();
  registerConsoleDynamicEventReporterPlugin(registry);
  await registry.runDynamicEventReporters(occurrences);
}

/** Every console.log argument list, as the exact strings that were printed. */
const printed = (): unknown[][] => log.mock.calls;

const HEADER = chalk.blue("\nDynamic event names:");
const line = (text: string) => chalk.yellow(text);

describe("console dynamic event reporter: registration", () => {
  it("registers one reporter named console", () => {
    const registry = new PluginRegistry();
    registerConsoleDynamicEventReporterPlugin(registry);
    expect(registry.getDynamicEventReporters().map((r) => r.name)).toEqual(["console"]);
  });

  it("cannot be registered twice on the same registry", () => {
    const registry = new PluginRegistry();
    registerConsoleDynamicEventReporterPlugin(registry);
    expect(() => registerConsoleDynamicEventReporterPlugin(registry)).toThrow(
      new Error("Dynamic event reporter already registered: console"),
    );
  });
});

describe("console dynamic event reporter: what is printed", () => {
  it("prints nothing at all for no occurrences", async () => {
    await report();
    expect(printed()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it("prints the header once, then one line per occurrence, in order", async () => {
    await report(
      occurrence({ line: 10, calleeText: "sdk.track" }),
      occurrence({ fileName: `${CWD}/src/b.ts`, line: 3, calleeText: "analytics.capture" }),
      occurrence({ fileName: `${CWD}/src/c.ts`, line: 7, calleeText: "track" }),
    );
    expect(printed()).toEqual([
      [HEADER],
      [line("~ src/a.ts:10 sdk.track(...)")],
      [line("~ src/b.ts:3 analytics.capture(...)")],
      [line("~ src/c.ts:7 track(...)")],
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it("appends the resolved values, joined by a comma and a space, only when there are some", async () => {
    await report(
      occurrence({ resolvedValues: ["checkout:done"] }),
      occurrence({ resolvedValues: ["a", "b", "c"] }),
      occurrence({ resolvedValues: [] }),
    );
    expect(printed().slice(1)).toEqual([
      [line("~ src/a.ts:10 sdk.track(...) (resolved: checkout:done)")],
      [line("~ src/a.ts:10 sdk.track(...) (resolved: a, b, c)")],
      [line("~ src/a.ts:10 sdk.track(...)")],
    ]);
  });

  it("describes a template event by its expression, not by a line number", async () => {
    await report(
      occurrence({ fileName: `${CWD}/src/App.vue`, inTemplate: true, eventExpression: "item.name", calleeText: "__eventra_vue_template_event__" }),
      occurrence({ fileName: `${CWD}/src/App.vue`, inTemplate: true, eventExpression: "kind", resolvedValues: ["x", "y"] }),
    );
    expect(printed().slice(1)).toEqual([
      [line('~ template of src/App.vue: event="item.name"')],
      [line('~ template of src/App.vue: event="kind" (resolved: x, y)')],
    ]);
  });

  it("prints an empty expression for a template event that carries none", async () => {
    await report(occurrence({ fileName: `${CWD}/src/App.vue`, inTemplate: true }));
    expect(printed()[1]).toEqual([line('~ template of src/App.vue: event=""')]);
  });

  it("describes code copied out of a template by its callee, not by a line number", async () => {
    await report(
      occurrence({ fileName: `${CWD}/src/App.vue`, inTemplateCode: true, calleeText: "sdk.track", line: 42 }),
      occurrence({ fileName: `${CWD}/src/App.vue`, inTemplateCode: true, calleeText: "track", resolvedValues: ["p", "q"] }),
    );
    expect(printed().slice(1)).toEqual([
      [line("~ template of src/App.vue: sdk.track(...)")],
      [line("~ template of src/App.vue: track(...) (resolved: p, q)")],
    ]);
  });

  it("prefers the template-event form over the template-code form when both flags are set", async () => {
    await report(
      occurrence({ fileName: `${CWD}/src/App.vue`, inTemplate: true, inTemplateCode: true, eventExpression: "e", calleeText: "c" }),
    );
    expect(printed()[1]).toEqual([line('~ template of src/App.vue: event="e"')]);
  });

  it("treats explicit false flags like absent ones", async () => {
    await report(occurrence({ inTemplate: false, inTemplateCode: false, inGeneratedCode: false }));
    expect(printed()[1]).toEqual([line("~ src/a.ts:10 sdk.track(...)")]);
  });
});

describe("console dynamic event reporter: generated copies", () => {
  it("skips occurrences in generated code, and prints no header when only those exist", async () => {
    await report(occurrence({ inGeneratedCode: true }), occurrence({ inGeneratedCode: true, line: 2 }));
    expect(printed()).toEqual([]);
  });

  it("prints the header and the remaining lines when some occurrences are not generated", async () => {
    await report(
      occurrence({ inGeneratedCode: true, line: 1 }),
      occurrence({ fileName: `${CWD}/src/c.component.ts`, line: 9 }),
      occurrence({ inGeneratedCode: true, line: 2 }),
    );
    expect(printed()).toEqual([[HEADER], [line("~ src/c.component.ts:9 sdk.track(...)")]]);
  });

  it("skips a generated occurrence whatever other flags it has", async () => {
    await report(occurrence({ inGeneratedCode: true, inTemplate: true, inTemplateCode: true }));
    expect(printed()).toEqual([]);
  });
});

describe("console dynamic event reporter: paths", () => {
  const shown = async (fileName: string): Promise<unknown> => {
    log.mockClear();
    await report(occurrence({ fileName }));
    return printed()[1]?.[0];
  };

  it("prints a file inside the working directory relative to it", async () => {
    expect(await shown(`${CWD}/src/deep/er/a.ts`)).toBe(line("~ src/deep/er/a.ts:10 sdk.track(...)"));
    expect(await shown(`${CWD}/a.ts`)).toBe(line("~ a.ts:10 sdk.track(...)"));
  });

  it("keeps the absolute path for a file outside the working directory", async () => {
    expect(await shown("/definitely/elsewhere/x.ts")).toBe(line("~ /definitely/elsewhere/x.ts:10 sdk.track(...)"));
    expect(await shown("/work/other/x.ts")).toBe(line("~ /work/other/x.ts:10 sdk.track(...)"));
    expect(await shown("/work/proj2/x.ts")).toBe(line("~ /work/proj2/x.ts:10 sdk.track(...)"));
    expect(await shown("/work/x.ts")).toBe(line("~ /work/x.ts:10 sdk.track(...)"));
  });

  it("keeps the absolute path for the parent of the working directory (relative path is exactly ..)", async () => {
    expect(await shown("/work")).toBe(line("~ /work:10 sdk.track(...)"));
  });

  it("keeps the path as given when it is the working directory itself (empty relative path)", async () => {
    expect(await shown(CWD)).toBe(line(`~ ${CWD}:10 sdk.track(...)`));
  });

  it("treats a name that merely starts with two dots as inside the working directory", async () => {
    expect(await shown(`${CWD}/..hidden.ts`)).toBe(line("~ ..hidden.ts:10 sdk.track(...)"));
    // a path that climbs out of it is shown exactly as given, not normalized
    expect(await shown(`${CWD}/..`)).toBe(line("~ /work/proj/..:10 sdk.track(...)"));
  });

  it("prints backslashes as forward slashes", async () => {
    expect(await shown(`${CWD}/src\\win\\a.ts`)).toBe(line("~ src/win/a.ts:10 sdk.track(...)"));
    expect(await shown("/elsewhere\\win\\a.ts")).toBe(line("~ /elsewhere/win/a.ts:10 sdk.track(...)"));
  });

  it("uses the same relative form in template lines", async () => {
    log.mockClear();
    await report(occurrence({ fileName: `${CWD}/src/App.vue`, inTemplate: true, eventExpression: "e" }));
    expect(printed()[1]).toEqual([line('~ template of src/App.vue: event="e"')]);
    log.mockClear();
    await report(occurrence({ fileName: "/elsewhere/App.vue", inTemplateCode: true }));
    expect(printed()[1]).toEqual([line("~ template of /elsewhere/App.vue: sdk.track(...)")]);
  });
});
