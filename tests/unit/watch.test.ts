import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@eventra_dev/cli-plugin-fixture-watch-broken", () => ({
  default: {
    id: "watch-broken",
    includeGlobs: ["**/*.broken"],
    match: (file: string) => file.endsWith(".broken"),
    transform: async ({ path: file }: { path: string }) => {
      throw new Error(`Failed to parse Broken SFC ${file}: Element is missing end tag.`);
    },
  },
}));

vi.mock("@eventra_dev/cli-plugin-fixture-watch-slow", () => ({
  default: {
    id: "watch-slow",
    includeGlobs: ["**/*.slow"],
    match: (file: string) => file.endsWith(".slow"),
    transform: async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return { modules: [] };
    },
  },
}));

import fsExtra from "fs-extra";
import fsPromises from "fs/promises";

import { watch, type WatchHandle } from "../../src/cli/watch";
import { EventraEngine } from "../../src/core/EventraEngine";

const SDK = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst t = new Eventra({ apiKey: "k" });\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Polls instead of sleeping a fixed time: a loaded machine can take seconds to rebuild.
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(100);
  }
}

let cwd: string;
let handle: WatchHandle | undefined;
let logs: string[];
let errors: string[];

function write(rel: string, content: string) {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const readEvents = (): string[] => JSON.parse(fs.readFileSync(path.join(cwd, "eventra.json"), "utf8")).events;
const updates = () => logs.filter((l) => l.includes("Updated:")).length;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-watch-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  write(
    "eventra.json",
    JSON.stringify({
      endpoint: "",
      events: [],
      functionWrappers: [],
      plugins: [
        "@eventra_dev/cli-plugin-fixture-watch-broken",
        "@eventra_dev/cli-plugin-fixture-watch-slow",
      ],
      sync: { include: ["**/*.{ts,tsx,js,jsx}"], exclude: ["node_modules", "dist"] },
    }),
  );
  write("src/a.ts", `${SDK}t.track("first.event");\n`);
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("watch", () => {
  it("returns nothing and fails with exit code 1 when there is no config", async () => {
    fs.rmSync(path.join(cwd, "eventra.json"));
    expect(await watch()).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("does not feed on its own eventra.json and ignores files it does not scan", async () => {
    handle = await watch();
    await sleep(1200);
    expect(readEvents()).toEqual(["first.event"]);

    write("src/a.ts", `${SDK}t.track("first.event");\nt.track("second.event");\n`);
    await waitFor(() => readEvents().includes("second.event"));
    await sleep(1500);

    // eventra.json was rewritten above; it must not schedule more runs. The old
    // watcher kept going (several "Updated:" lines for one edit), so the count
    // has to stay put across a quiet window.
    const afterEdit = updates();
    expect(afterEdit).toBeGreaterThanOrEqual(1);
    expect(afterEdit).toBeLessThanOrEqual(2);
    await sleep(2000);
    expect(updates()).toBe(afterEdit);

    // files that are not scanned (non-matching extension, nested node_modules/dist) trigger nothing
    write("README.md", "# hi\n");
    write("packages/web/node_modules/x/b.ts", `${SDK}t.track("nm.event");\n`);
    write("packages/web/dist/c.ts", `${SDK}t.track("dist.event");\n`);
    await sleep(2000);

    expect(updates()).toBe(afterEdit);
    expect(readEvents()).toEqual(["first.event", "second.event"]);
  }, 60_000);

  it("picks up a brand-new matching file", async () => {
    handle = await watch();
    await sleep(1200);

    write("src/new.ts", `${SDK}t.track("brand.new");\n`);
    await waitFor(() => readEvents().includes("brand.new"));

    expect(readEvents()).toEqual(["brand.new", "first.event"]);
  }, 60_000);

  it("reports a file that fails to parse with a clean reason and keeps known events", async () => {
    handle = await watch();
    await sleep(1200);

    write("src/Bad.broken", "<template><div></template>");
    await waitFor(() => errors.some((e) => e.includes("Bad.broken")));
    await sleep(500);

    const skipLines = errors.filter((e) => e.includes("Bad.broken"));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toContain("Element is missing end tag.");
    expect(skipLines[0].match(/Bad\.broken/g)).toHaveLength(1);
    expect(readEvents()).toEqual(["first.event"]);

    // a later successful edit elsewhere still keeps the known events while the broken file is unresolved
    write("src/a.ts", `${SDK}t.track("first.event");\nt.track("third.event");\n`);
    await waitFor(() => readEvents().includes("third.event"));
    expect(readEvents()).toEqual(["first.event", "third.event"]);
  }, 60_000);

  it("drops the events of a deleted source file", async () => {
    write("src/b.ts", `${SDK}t.track("b.event");\n`);
    handle = await watch();
    await sleep(1200);
    expect(readEvents()).toEqual(["b.event", "first.event"]);

    fs.rmSync(path.join(cwd, "src/b.ts"));
    await waitFor(() => !readEvents().includes("b.event"));

    expect(readEvents()).toEqual(["first.event"]);
    expect(logs.some((l) => l.includes("Removed ->"))).toBe(true);
  }, 60_000);

  it("ignores the removal of a file it never scanned", async () => {
    write("notes.md", "x");
    handle = await watch();
    await sleep(1200);

    fs.rmSync(path.join(cwd, "notes.md"));
    await sleep(1200);

    expect(logs.some((l) => l.includes("Removed ->"))).toBe(false);
  }, 60_000);

  it("follows relative imports as they are added and removed, and keeps shared ones", async () => {
    write("src/util.ts", "export const u = 1;\n");
    write("src/other.ts", "export const o = 1;\n");
    write("src/a.ts", `import "./util";\n${SDK}t.track("first.event");\n`);
    handle = await watch();
    await sleep(1200);
    const before = updates();

    // ./util stays, ./other is added
    write("src/a.ts", `import "./util";\nimport "./other";\n${SDK}t.track("first.event");\nt.track("deps.one");\n`);
    await waitFor(() => readEvents().includes("deps.one"));
    // ./other is dropped again
    write("src/a.ts", `import "./util";\n${SDK}t.track("first.event");\nt.track("deps.two");\n`);
    await waitFor(() => readEvents().includes("deps.two"));

    expect(updates()).toBeGreaterThan(before);
    expect(readEvents()).toEqual(["deps.two", "first.event"]);
  }, 60_000);

  it("reports a file that is already broken at startup and keeps the known events", async () => {
    write("src/Bad.broken", "<template><div></template>");
    const config = JSON.parse(fs.readFileSync(path.join(cwd, "eventra.json"), "utf8"));
    config.events = ["known.event"];
    fs.writeFileSync(path.join(cwd, "eventra.json"), JSON.stringify(config));

    handle = await watch();

    expect(errors.some((e) => e.includes("Skipped 1 file") && e.includes("Bad.broken"))).toBe(true);
    expect(readEvents()).toEqual(["first.event", "known.event"]);
  }, 60_000);

  it("runs edits one at a time and tolerates a run that finds nothing left to do", async () => {
    handle = await watch();
    await sleep(1200);

    // a slow preprocessor keeps the first run busy while two more bursts queue up behind it
    write("src/x.slow", "x");
    await sleep(500);
    write("src/a.ts", `${SDK}t.track("first.event");\nt.track("queued.one");\n`);
    await sleep(500);
    write("src/a.ts", `${SDK}t.track("first.event");\nt.track("queued.one");\nt.track("queued.two");\n`);

    await waitFor(() => readEvents().includes("queued.two"), 30_000);
    expect(errors.filter((e) => e.includes("watch error"))).toEqual([]);
  }, 60_000);

  it("reports a failure while saving instead of crashing, then keeps working", async () => {
    handle = await watch();
    await sleep(1200);

    const spy = vi.spyOn(fsExtra, "writeFile").mockRejectedValueOnce(new Error("disk full") as never);
    write("src/a.ts", `${SDK}t.track("first.event");\nt.track("will.fail");\n`);
    await waitFor(() => errors.some((e) => e.includes("watch error: disk full")));
    spy.mockRestore();

    write("src/a.ts", `${SDK}t.track("first.event");\nt.track("recovered");\n`);
    await waitFor(() => readEvents().includes("recovered"));
  }, 60_000);

  it("closes the watcher and exits cleanly on SIGINT", async () => {
    const handlers: Array<() => Promise<void>> = [];
    const on = vi.spyOn(process, "on").mockImplementation(((event: string, fn: () => Promise<void>) => {
      if (event === "SIGINT") handlers.push(fn);
      return process;
    }) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    handle = await watch();
    expect(handlers).toHaveLength(1);
    await handlers[0]();

    expect(exit).toHaveBeenCalledWith(0);
    on.mockRestore();
  }, 60_000);
});



describe("watch: oversized, deleted-while-failed and dot-directory files", () => {
  it("ignores a file over 2 MB at startup (not a skip), and keeps working on the rest", async () => {
    write("src/big.ts", `${SDK}t.track("big.event");\n// ${"x".repeat(2_000_001)}\n`);
    handle = await watch();

    expect(errors.some((e) => e.includes("Ignored 1 file") && e.includes("big.ts"))).toBe(true);
    expect(errors.some((e) => e.includes("Skipped"))).toBe(false);
    expect(readEvents()).toEqual(["first.event"]);
  }, 60_000);

  it("drops a file that grows past 2 MB (ignored, events not kept) and takes it back when it shrinks", async () => {
    handle = await watch();
    await sleep(1200);
    expect(readEvents()).toEqual(["first.event"]);

    write("src/a.ts", `${SDK}t.track("first.event");\n// ${"x".repeat(2_000_001)}\n`);
    await waitFor(() => errors.some((e) => e.includes("Ignored 1 file")));
    await waitFor(() => readEvents().length === 0);
    expect(errors.some((e) => e.includes("Skipped"))).toBe(false);

    write("src/a.ts", `${SDK}t.track("first.event");\n`);
    await waitFor(() => readEvents().includes("first.event"));
  }, 60_000);

  it("stops counting a failed file as skipped once it is deleted, so removed events are pruned again", async () => {
    handle = await watch();
    await sleep(1200);

    write("src/Bad.broken", "<template><div></template>");
    await waitFor(() => errors.some((e) => e.includes("Bad.broken")));

    // while it is broken every known event is kept
    write("src/a.ts", `${SDK}t.track("other.event");\n`);
    await waitFor(() => readEvents().includes("other.event"));
    expect(readEvents()).toEqual(["first.event", "other.event"]);

    fs.rmSync(path.join(cwd, "src/Bad.broken"));
    await waitFor(() => logs.some((l) => l.includes("Removed ->")));

    // the old event is no longer protected
    write("src/a.ts", `${SDK}t.track("other.event");\nt.track("again.event");\n`);
    await waitFor(() => readEvents().includes("again.event"));
    expect(readEvents()).toEqual(["again.event", "other.event"]);
  }, 60_000);

  it("treats a file that vanished before it could be read as a removal, not as a failure", async () => {
    handle = await watch();
    await sleep(1200);

    const real = fsPromises.readFile.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, "readFile").mockImplementation((async (file: unknown, ...rest: unknown[]) => {
      if (String(file).endsWith("ghost.ts")) {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      }
      return (real as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as never);

    write("src/ghost.ts", `${SDK}t.track("ghost.event");\n`);
    await waitFor(() => spy.mock.calls.some((c) => String(c[0]).endsWith("ghost.ts")));
    await sleep(800);
    spy.mockRestore();

    expect(errors.some((e) => e.includes("ghost.ts"))).toBe(false);
    expect(readEvents()).toEqual(["first.event"]);
  }, 60_000);

  it("does not pick up generated output in dot-directories, like sync (fast-glob dot:false)", async () => {
    handle = await watch();
    await sleep(1200);
    const before = updates();

    write(".svelte-kit/output/gen.ts", `${SDK}t.track("generated.event");\n`);
    write("src/.turbo/cache.ts", `${SDK}t.track("turbo.event");\n`);
    await sleep(2000);

    expect(updates()).toBe(before);
    expect(readEvents()).toEqual(["first.event"]);
  }, 60_000);
});

describe("watch: imported files outside include", () => {
  const useInclude = (include: string[]) => {
    const config = JSON.parse(fs.readFileSync(path.join(cwd, "eventra.json"), "utf8"));
    config.sync.include = include;
    fs.writeFileSync(path.join(cwd, "eventra.json"), JSON.stringify(config));
  };

  beforeEach(() => {
    useInclude(["src/**/*.ts"]);
    write("shared/events.ts", `export const EV = "shared.one";\n`);
    write("src/a.ts", `import { EV } from "../shared/events";\n${SDK}t.track(EV);\n`);
  });

  it("follows edits, deletion and re-creation of an imported file, like sync", async () => {
    handle = await watch();
    await sleep(1200);
    expect(readEvents()).toEqual(["shared.one"]);

    write("shared/events.ts", `export const EV = "shared.two";\n`);
    await waitFor(() => readEvents().includes("shared.two"));
    expect(readEvents()).toEqual(["shared.two"]);

    fs.rmSync(path.join(cwd, "shared/events.ts"));
    await waitFor(() => readEvents().length === 0);

    write("shared/events.ts", `export const EV = "shared.three";\n`);
    await waitFor(() => readEvents().includes("shared.three"));
    expect(readEvents()).toEqual(["shared.three"]);
  }, 60_000);

  it("reacts to an imported file being deleted as the very first change", async () => {
    handle = await watch();
    await sleep(1200);
    expect(readEvents()).toEqual(["shared.one"]);

    fs.rmSync(path.join(cwd, "shared/events.ts"));
    await waitFor(() => readEvents().length === 0);
    expect(readEvents()).toEqual([]);
  }, 60_000);

  it("does not rewrite or log when a new file outside include changes nothing", async () => {
    handle = await watch();
    await sleep(1200);
    const before = updates();

    write("tools/other.ts", `export const X = 1;\n`);
    await sleep(1500);
    fs.rmSync(path.join(cwd, "tools/other.ts"));
    await sleep(1500);

    expect(updates()).toBe(before);
    expect(readEvents()).toEqual(["shared.one"]);
  }, 60_000);

  it("reports a failure while refreshing imported files and keeps working", async () => {
    handle = await watch();
    await sleep(1200);

    const spy = vi.spyOn(EventraEngine.prototype, "refreshExternalFiles").mockRejectedValueOnce(new Error("boom"));
    write("shared/events.ts", `export const EV = "shared.broken";\n`);
    await waitFor(() => errors.some((e) => e.includes("watch error: boom")));
    spy.mockRestore();

    write("shared/events.ts", `export const EV = "shared.fixed";\n`);
    await waitFor(() => readEvents().includes("shared.fixed"));
  }, 60_000);

  it("watches an imported file that lives outside the project root, and stops when it is no longer imported", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-outside-"));
    try {
      const outsideFile = path.join(outside, "consts.ts");
      fs.writeFileSync(outsideFile, `export const OUT = "outside.one";\n`);
      const rel = path.relative(path.join(cwd, "src"), outsideFile).replace(/\\/g, "/");
      write("src/a.ts", `import { OUT } from "${rel}";\n${SDK}t.track(OUT);\n`);

      handle = await watch();
      await sleep(1500);
      expect(readEvents()).toEqual(["outside.one"]);

      fs.writeFileSync(outsideFile, `export const OUT = "outside.two";\n`);
      await waitFor(() => readEvents().includes("outside.two"));

      // no longer imported: it leaves the program and is unwatched
      write("src/a.ts", `${SDK}t.track("plain.event");\n`);
      await waitFor(() => readEvents().includes("plain.event"));
      const before = updates();
      fs.writeFileSync(outsideFile, `export const OUT = "outside.three";\n`);
      await sleep(1500);
      expect(updates()).toBe(before);
      expect(readEvents()).toEqual(["plain.event"]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);
});
