import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ overflowIndex: (_file: string) => false, overflowExtract: false, extractFails: false }));

// a plugin whose files become a virtual module of their own, so the skip can be traced back to the real file
vi.mock("@eventra_dev/cli-plugin-fixture-virtual", () => ({
  default: {
    id: "virtual",
    includeGlobs: ["**/*.fix"],
    match: (file: string) => file.endsWith(".fix"),
    transform: async ({ path: file }: { path: string }) => ({ modules: [{ path: `${file}.ts`, content: "export const a = 1;\n" }] }),
  },
}));

vi.mock("../../src/analysis/engine/analyzeFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/analysis/engine/analyzeFile")>();
  const overflow = () => new RangeError("Maximum call stack size exceeded");
  return {
    ...actual,
    indexSourceFile: (source: { fileName: string }, ...rest: unknown[]) => {
      if (control.overflowIndex(source.fileName)) throw overflow();
      return (actual.indexSourceFile as (...args: unknown[]) => unknown)(source, ...rest);
    },
    extractFromIndex: (index: { fileName: string }, ...rest: unknown[]) => {
      if (control.overflowExtract && index.fileName.endsWith("deep.ts")) throw overflow();
      if (control.extractFails) throw new Error("something else");
      return (actual.extractFromIndex as (...args: unknown[]) => unknown)(index, ...rest);
    },
  };
});

import { scanProject } from "../../src/core/projectScanner";
import { normalizeConfig } from "../../src/config/config";

let cwd: string;
const SDK = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst t = new Eventra({ apiKey: "k" });\n`;
const write = (rel: string, content: string) => {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const config = (plugins: string[] = []) => normalizeConfig({ plugins, sync: { include: ["**/*.ts"], exclude: ["node_modules"] } });

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-overflow-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.spyOn(console, "error").mockImplementation(() => {});
  control.overflowIndex = () => false;
  control.overflowExtract = false;
  control.extractFails = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("a file whose analysis overflows the call stack", () => {
  it("is reported as skipped with a reason, and the other files are still scanned (indexing)", async () => {
    write("src/ok.ts", `${SDK}t.track("fine.event");\n`);
    write("src/deep.ts", `${SDK}t.track("never.seen");\n`);
    control.overflowIndex = (file) => file.endsWith("deep.ts");
    const { engine, skipped } = await scanProject(config());
    expect(engine.getAllEvents()).toEqual(["fine.event"]);
    expect(skipped).toHaveLength(1);
    expect(path.relative(cwd, skipped[0].file)).toBe("src/deep.ts");
    expect(skipped[0].reason).toMatch(/nests too deeply/);
  });

  it("is reported as skipped too when extraction overflows", async () => {
    write("src/ok.ts", `${SDK}t.track("fine.event");\n`);
    write("src/deep.ts", `${SDK}t.track("never.seen");\n`);
    control.overflowExtract = true;
    const { engine, skipped } = await scanProject(config());
    expect(engine.getAllEvents()).toEqual(["fine.event"]);
    expect(skipped.map((s) => path.relative(cwd, s.file))).toEqual(["src/deep.ts"]);
  });

  it("names the file the user wrote when the overflow happened in a plugin's generated module", async () => {
    write("src/Page.fix", "anything");
    control.overflowIndex = (file) => file.endsWith(".fix.ts");
    const { skipped } = await scanProject(config(["@eventra_dev/cli-plugin-fixture-virtual"]));
    expect(skipped.map((s) => path.relative(cwd, s.file))).toEqual(["src/Page.fix"]);
  });

  it("is not reported again once the file is fine", async () => {
    write("src/ok.ts", `${SDK}t.track("fine.event");\n`);
    expect((await scanProject(config())).skipped).toEqual([]);
  });

  it("an extraction error that is not a stack overflow still propagates", async () => {
    write("src/ok.ts", `${SDK}t.track("fine.event");\n`);
    control.extractFails = true;
    await expect(scanProject(config())).rejects.toThrow("something else");
  });

  it("an error that is not a stack overflow still propagates", async () => {
    write("src/ok.ts", `${SDK}t.track("fine.event");\n`);
    control.overflowIndex = () => {
      throw new Error("something else");
    };
    await expect(scanProject(config())).rejects.toThrow();
  });
});
