import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { normalizeConfig } from "../../src/config/config";
import { scanProject } from "../../src/core/projectScanner";
import type { EventraConfig } from "../../src/types";

// Files that are imported but live outside `include` (shared constants, helpers)
// are not scanned, yet they decide what a scanned file's event names are. A
// long-running engine (watch) must agree with a brand new scan after such a
// file changes, appears or vanishes.

let cwd: string;

const SDK = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst t = new Eventra({ apiKey: "k" });\n`;

const config = (): EventraConfig =>
  normalizeConfig({ sync: { include: ["src/**/*.ts"], exclude: ["node_modules"] } });

function write(rel: string, content: string) {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function freshEvents(): Promise<string[]> {
  return (await scanProject(config())).engine.getAllEvents();
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-external-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("EventraEngine.refreshExternalFiles", () => {
  it("picks up an edit of an imported file outside include, like a fresh scan", async () => {
    write("shared/events.ts", `export const EV = "first.event";\n`);
    write("src/app.ts", `import { EV } from "../shared/events";\n${SDK}t.track(EV);\n`);

    const { engine } = await scanProject(config());
    expect(engine.getAllEvents()).toEqual(["first.event"]);

    write("shared/events.ts", `export const EV = "second.event";\n`);
    expect(await engine.refreshExternalFiles([path.join(cwd, "shared/events.ts")], config())).toBe(true);

    expect(engine.getAllEvents()).toEqual(["second.event"]);
    expect(engine.getAllEvents()).toEqual(await freshEvents());
  });

  it("reports false and keeps results when the content did not change", async () => {
    write("shared/events.ts", `export const EV = "first.event";\n`);
    write("src/app.ts", `import { EV } from "../shared/events";\n${SDK}t.track(EV);\n`);
    const { engine } = await scanProject(config());

    expect(await engine.refreshExternalFiles([path.join(cwd, "shared/events.ts")], config())).toBe(false);
    expect(engine.getAllEvents()).toEqual(["first.event"]);
  });

  it("follows a chain of imported files (edit the one at the end)", async () => {
    write("shared/base.ts", `export const BASE = "base";\n`);
    write("shared/events.ts", `import { BASE } from "./base";\nexport const EV = BASE + ".event";\n`);
    write("src/app.ts", `import { EV } from "../shared/events";\n${SDK}t.track(EV);\n`);
    const { engine } = await scanProject(config());
    expect(engine.getAllEvents()).toEqual(["base.event"]);

    write("shared/base.ts", `export const BASE = "changed";\n`);
    await engine.refreshExternalFiles([path.join(cwd, "shared/base.ts")], config());

    expect(engine.getAllEvents()).toEqual(["changed.event"]);
    expect(engine.getAllEvents()).toEqual(await freshEvents());
  });

  it("resolves an import whose target did not exist yet, and loses it again when the target is deleted", async () => {
    write("src/app.ts", `import { LATER } from "../shared/later";\n${SDK}t.track(LATER);\n`);
    const { engine } = await scanProject(config());
    expect(engine.getAllEvents()).toEqual([]);

    const later = write("shared/later.ts", `export const LATER = "arrived.event";\n`);
    await engine.refreshExternalFiles([later], config());
    expect(engine.getAllEvents()).toEqual(["arrived.event"]);
    expect(engine.getAllEvents()).toEqual(await freshEvents());

    fs.rmSync(later);
    await engine.refreshExternalFiles([later], config());
    expect(engine.getAllEvents()).toEqual([]);
    expect(engine.getAllEvents()).toEqual(await freshEvents());
  });

  it("never reports events written inside an imported-only file, as a fresh scan does not", async () => {
    write("shared/util.ts", `${SDK}export function ping() { t.track("util.event"); }\n`);
    write("src/app.ts", `import { ping } from "../shared/util";\nping();\n${SDK.replace("const t", "const t2").replace(/t\.track/g, "t2.track")}t2.track("app.event");\n`);
    const { engine } = await scanProject(config());
    expect(engine.getAllEvents()).toEqual(await freshEvents());
    expect(engine.getAllEvents()).not.toContain("util.event");

    write("shared/util.ts", `${SDK}export function ping() { t.track("util.event.v2"); }\n`);
    await engine.refreshExternalFiles([path.join(cwd, "shared/util.ts")], config());

    expect(engine.getAllEvents()).not.toContain("util.event.v2");
    expect(engine.getAllEvents()).toEqual(await freshEvents());
  });

  it("handles a batch of files with one rebuild and ignores an unrelated new file", async () => {
    write("shared/a.ts", `export const A = "a1";\n`);
    write("shared/b.ts", `export const B = "b1";\n`);
    write("src/app.ts", `import { A } from "../shared/a";\nimport { B } from "../shared/b";\n${SDK}t.track(A);\nt.track(B);\n`);
    const { engine } = await scanProject(config());

    write("shared/a.ts", `export const A = "a2";\n`);
    write("shared/b.ts", `export const B = "b2";\n`);
    const unrelated = write("tools/other.ts", `export const X = 1;\n`);
    await engine.refreshExternalFiles(
      [path.join(cwd, "shared/a.ts"), path.join(cwd, "shared/b.ts"), unrelated],
      config(),
    );

    expect(engine.getAllEvents()).toEqual(["a2", "b2"]);
    expect(engine.getAllEvents()).toEqual(await freshEvents());
    // nothing imports the unrelated file, so it does not linger in the program
    expect(engine.hasProgramFile(unrelated)).toBe(false);
  });

  it("exposes which files are in the program", async () => {
    write("shared/events.ts", `export const EV = "first.event";\n`);
    write("src/app.ts", `import { EV } from "../shared/events";\n${SDK}t.track(EV);\n`);
    const { engine } = await scanProject(config());

    expect(engine.hasProgramFile(path.join(cwd, "shared/events.ts"))).toBe(true);
    expect(engine.hasProgramFile(path.join(cwd, "src/missing.ts"))).toBe(false);
    const names = engine.getProjectFileNames().map((f) => f.replace(/\\/g, "/"));
    expect(names).toContain(`${cwd}/shared/events.ts`.replace(/\\/g, "/"));
    expect(names.some((f) => f.includes("/node_modules/") || f.includes("typescript/lib"))).toBe(false);
  });
});

describe("CompilerContext.refreshFromDisk", () => {
  it("returns nothing when nothing changed and drops a file that no longer exists", () => {
    const file = write("shared/x.ts", `export const X = 1;\n`);
    const ctx = new CompilerContext(cwd);
    ctx.stageFile(path.join(cwd, "src/a.ts"), `import { X } from "../shared/x";\nexport const a = X;\n`);
    ctx.flushUpdates();
    expect(ctx.hasFile(file)).toBe(true);

    expect(ctx.refreshFromDisk([file])).toEqual([]);

    fs.rmSync(file);
    expect(ctx.refreshFromDisk([file])).toEqual([file.replace(/\\/g, "/")]);
    expect(ctx.hasFile(file)).toBe(false);
  });
});
