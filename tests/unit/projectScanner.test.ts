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

// a plugin that writes the user's script and a generated template region into one virtual module
vi.mock("@eventra_dev/cli-plugin-fixture-syntax", () => ({
  default: {
    id: "syntax",
    includeGlobs: ["**/*.syn"],
    match: (file: string) => file.endsWith(".syn"),
    transform: async ({ path: file, source }: { path: string; source: string }) => ({
      modules: [{ path: `${file}.ts`, content: source }],
    }),
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

  it("uses the project's sync.maxFileSize, and says so in the reason", async () => {
    write("src/big.ts", `${SDK_IMPORT}t.track("big.event");\n// ${"x".repeat(300)}\n`);
    write("src/app.ts", `${SDK_IMPORT}t.track("real.event");\n`);

    const small = await scanProject(config({ sync: { include: ["**/*.{ts,tsx,js,jsx}"], exclude: ["node_modules", "dist"], maxFileSize: 200 } }));
    expect(small.engine.getAllEvents()).toEqual(["real.event"]);
    expect(small.ignored).toEqual([{ file: path.join(cwd, "src/big.ts"), reason: "file is larger than 200 characters (sync.maxFileSize)" }]);

    const roomy = await scanProject(config({ sync: { include: ["**/*.{ts,tsx,js,jsx}"], exclude: ["node_modules", "dist"], maxFileSize: 10_000 } }));
    expect(roomy.engine.getAllEvents()).toEqual(["big.event", "real.event"]);
    expect(roomy.ignored).toEqual([]);
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

describe("scanProject: syntax errors and rejected names", () => {
  it("lists a file with a syntax error, still reads the events before it, and does not skip it", async () => {
    write("src/ok.ts", `${SDK_IMPORT}t.track("fine.one");\n`);
    write("src/broken.ts", `${SDK_IMPORT}t.track("before.error");\nconst x = ;\n`);

    const { engine, skipped, syntaxErrors } = await scanProject(config());

    expect(skipped).toEqual([]);
    expect(syntaxErrors.map((s) => [path.relative(cwd, s.file), s.reason])).toEqual([
      ["src/broken.ts", expect.stringMatching(/^line 4: /)],
    ]);
    expect(engine.getAllEvents()).toEqual(["before.error", "fine.one"]);
  });

  it("reports nothing for a project without syntax errors, and names that cannot be accepted by the engine", async () => {
    write("src/ok.ts", `${SDK_IMPORT}t.track("fine.one");\nt.track("not\\tfine");\n`);

    const { engine, syntaxErrors } = await scanProject(config());

    expect(syntaxErrors).toEqual([]);
    expect(engine.getAllEvents()).toEqual(["fine.one"]);
    expect(engine.getAllRejectedNames().map((r) => r.name)).toEqual(["not\tfine"]);
  });
});

describe("scanProject: component files no plugin reads", () => {
  it("reports .vue, .svelte and .astro files that nothing handles, grouped per extension with the plugin to install", async () => {
    write("src/a.ts", SDK_IMPORT + `t.track("a.event");\n`);
    write("src/One.vue", "<template><p/></template>");
    write("src/deep/Two.vue", "<template><p/></template>");
    write("src/Card.svelte", "<p/>");
    write("src/Page.astro", "---\n---\n<p/>");
    write("node_modules/dep/X.vue", "<template/>");
    const { unread } = await scanProject(config());
    expect(unread.map((group) => [group.extension, group.plugin, group.files.map((file) => path.relative(cwd, file))])).toEqual([
      ["vue", "@eventra_dev/cli-plugin-vue", ["src/One.vue", "src/deep/Two.vue"]],
      ["svelte", "@eventra_dev/cli-plugin-svelte", ["src/Card.svelte"]],
      ["astro", "@eventra_dev/cli-plugin-astro", ["src/Page.astro"]],
    ]);
  });

  it("reports nothing for a project with no component files", async () => {
    write("src/a.ts", SDK_IMPORT + `t.track("a.event");\n`);
    expect((await scanProject(config())).unread).toEqual([]);
  });

  it("looks wherever a plugin would have looked: sync.include does not narrow it, sync.exclude does", async () => {
    write("src/One.vue", "<template/>");
    write("other/Two.vue", "<template/>");
    write("node_modules/dep/Three.vue", "<template/>");
    const { unread } = await scanProject(config({ sync: { include: ["src/**/*.ts"], exclude: ["node_modules"] } }));
    expect(unread[0].files.map((file) => path.relative(cwd, file))).toEqual(["other/Two.vue", "src/One.vue"]);
  });

  it("a component file named in sync.include with no plugin is not parsed as TypeScript", async () => {
    write("src/One.vue", "<template><p @click=\"go()\">hi</p></template>\n<script>export default { }</script>");
    const { syntaxErrors, skipped, unread } = await scanProject(config({ sync: { include: ["src/**/*.{ts,vue}"], exclude: ["node_modules"] } }));
    expect(syntaxErrors).toEqual([]);
    expect(skipped).toEqual([]);
    expect(unread).toHaveLength(1);
  });

  it("does not report a file a loaded plugin handles", async () => {
    write("src/Ok.broken", "x");
    write("src/One.vue", "<template/>");
    const { unread, skipped } = await scanProject(config({ plugins: ["@eventra_dev/cli-plugin-fixture-broken"] }));
    expect(skipped).toHaveLength(1);
    expect(unread[0].extension).toBe("vue");
    expect(unread).toHaveLength(1);
  });
});

vi.mock("@eventra_dev/cli-plugin-fixture-partial", () => ({
  default: {
    id: "partial",
    includeGlobs: ["**/*.part"],
    match: (file: string) => file.endsWith(".part"),
    transform: async ({ path: file }: { path: string }) => ({ modules: [{ path: `${file}.ts`, content: "export {};\n" }], partial: ["the template was too large"] }),
  },
}));

describe("scanProject: a file a plugin read only in part", () => {
  it("is listed with the plugin's reason", async () => {
    write("src/Big.part", "x");
    const { partial } = await scanProject(config({ plugins: ["@eventra_dev/cli-plugin-fixture-partial"] }));
    expect(partial.map((p) => [path.relative(cwd, p.file), p.reason])).toEqual([["src/Big.part", "the template was too large"]]);
  });

  it("is not listed when there is none", async () => {
    write("src/a.ts", SDK_IMPORT + `t.track("a.event");\n`);
    expect((await scanProject(config())).partial).toEqual([]);
  });
});

describe("scanProject: syntax errors in a plugin's component files", () => {
  const withPlugin = () => config({ plugins: ["@eventra_dev/cli-plugin-fixture-syntax"] });

  it("reports a syntax error in the code the user wrote, as for a plain file", async () => {
    write("src/A.syn", `const a = ;\nexport {};\n`);
    const { syntaxErrors } = await scanProject(withPlugin());
    expect(syntaxErrors).toHaveLength(1);
    expect(path.relative(cwd, syntaxErrors[0].file)).toBe("src/A.syn");
    expect(syntaxErrors[0].reason).toMatch(/^line 1:/);
  });

  it("says nothing about a broken line inside the generated template region", async () => {
    write("src/B.syn", `export {};\n// --- vue template (auto-generated) ---\nconst a = ;\n// --- end template ---\n`);
    expect((await scanProject(withPlugin())).syntaxErrors).toEqual([]);
  });

  it("a component file in include is left to the unread list also when some other plugin is loaded", async () => {
    write("src/A.vue", "<template><p/></template>");
    write("src/A.syn", "export const a = 1;\n");
    const { skipped, syntaxErrors, unread } = await scanProject(
      config({ plugins: ["@eventra_dev/cli-plugin-fixture-syntax"], sync: { include: ["src/**/*.{ts,vue}"], exclude: ["node_modules"] } }),
    );
    expect(skipped).toEqual([]);
    expect(syntaxErrors).toEqual([]);
    expect(unread.map((group) => group.extension)).toEqual(["vue"]);
  });

  it("reports nothing for a file that is fine", async () => {
    write("src/C.syn", `export const a = 1;\n`);
    expect((await scanProject(withPlugin())).syntaxErrors).toEqual([]);
  });
});
