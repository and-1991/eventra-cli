import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A plugin whose transform always fails the way the Vue/Svelte/Astro plugins do
// on a broken file; vi.mock intercepts the import of this specifier.
vi.mock("@eventra_dev/cli-plugin-fixture-broken", () => ({
  default: {
    id: "broken",
    includeGlobs: ["**/*.broken"],
    match: (file: string) => file.endsWith(".broken"),
    transform: async ({ path: file }: { path: string }) => {
      throw new Error(`Failed to parse Broken SFC ${file}: Element is missing end tag.`);
    },
  },
}));

import { scanProject } from "../../src/core/projectScanner";
import { normalizeConfig } from "../../src/config/config";
import type { EventraConfig } from "../../src/types";

let cwd: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const SDK_IMPORT = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst t = new Eventra({ apiKey: "k" });\n`;

function write(rel: string, content: string) {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const config = (overrides: Partial<EventraConfig> = {}): EventraConfig =>
  normalizeConfig({ sync: { include: ["**/*.{ts,tsx,js,jsx}"], exclude: ["node_modules", "dist"] }, ...overrides });

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-scan-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cwdSpy.mockRestore();
  errorSpy.mockRestore();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("scanProject: exclude patterns", () => {
  it("skips nested node_modules and dist, not only the ones at the repo root", async () => {
    write("src/app.ts", `${SDK_IMPORT}t.track("real.event");\n`);
    write("node_modules/lib/a.ts", `${SDK_IMPORT}t.track("root.nm");\n`);
    write("packages/web/node_modules/lib/b.ts", `${SDK_IMPORT}t.track("nested.nm");\n`);
    write("packages/web/dist/c.ts", `${SDK_IMPORT}t.track("nested.dist");\n`);

    const { engine, files } = await scanProject(config());

    expect(files.map((f) => path.relative(cwd, f)).sort()).toEqual(["src/app.ts"]);
    expect(engine.getAllEvents()).toEqual(["real.event"]);
  });
});

describe("scanProject: skipped files", () => {
  it("collects a file that fails to transform once, with a clean reason and no console noise", async () => {
    write("src/app.ts", `${SDK_IMPORT}t.track("real.event");\n`);
    write("src/Bad.broken", "<template><div></template>");

    const { engine, skipped } = await scanProject(
      config({ plugins: ["@eventra_dev/cli-plugin-fixture-broken"] }),
    );

    expect(engine.getAllEvents()).toEqual(["real.event"]);
    expect(skipped).toEqual([
      { file: path.join(cwd, "src/Bad.broken"), reason: "Element is missing end tag." },
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("lists files over 2 MB as ignored, not as skipped failures", async () => {
    write("src/big.ts", `${SDK_IMPORT}t.track("big.event");\n// ${"x".repeat(2_000_001)}\n`);
    write("src/app.ts", `${SDK_IMPORT}t.track("real.event");\n`);

    const { engine, skipped, ignored } = await scanProject(config());

    expect(engine.getAllEvents()).toEqual(["real.event"]);
    expect(skipped).toEqual([]);
    expect(ignored).toEqual([{ file: path.join(cwd, "src/big.ts"), reason: "file is larger than 2 MB" }]);
  });

  it("returns an empty list for a clean project", async () => {
    write("src/app.ts", `${SDK_IMPORT}t.track("real.event");\n`);
    expect((await scanProject(config())).skipped).toEqual([]);
  });
});

describe("scanProject: extensionless relative imports", () => {
  it("does not print preload ENOENT noise or list phantom files", async () => {
    write("src/util.ts", `export const name = "util.event";\n`);
    write("src/app.ts", `import { name } from "./util";\n${SDK_IMPORT}t.track(name);\n`);

    const { engine, results } = await scanProject(config());

    expect(errorSpy).not.toHaveBeenCalled();
    expect([...results.keys()].map((f) => path.relative(cwd, f)).sort()).toEqual([
      "src/app.ts",
      "src/util.ts",
    ]);
    expect(engine.getAllEvents()).toEqual(["util.event"]);
  });
});
