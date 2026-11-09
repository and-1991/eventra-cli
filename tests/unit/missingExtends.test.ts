import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompilerContext } from "../../src/compiler/compilerContext";

let root: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-extends-"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const tsconfig = (extendsPath: string) => fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ extends: extendsPath }));
const messages = () => warn.mock.calls.map((call) => String(call[0]));

describe("a tsconfig.json that extends a file that does not exist", () => {
  it("warns and names svelte-kit sync for SvelteKit", () => {
    tsconfig("./.svelte-kit/tsconfig.json");
    new CompilerContext(root);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain("does not exist");
    expect(messages()[0]).toContain("npx svelte-kit sync");
  });

  it("names nuxt prepare for Nuxt", () => {
    tsconfig("./.nuxt/tsconfig.json");
    new CompilerContext(root);
    expect(messages()[0]).toContain("npx nuxt prepare");
  });

  it("warns without a hint for any other file", () => {
    tsconfig("./base/tsconfig.json");
    new CompilerContext(root);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).not.toContain("npx ");
  });

  it("also warns for a package of a monorepo with a tsconfig of its own, once, naming the file", () => {
    fs.mkdirSync(path.join(root, "packages", "web"), { recursive: true });
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    fs.writeFileSync(path.join(root, "packages", "web", "tsconfig.json"), JSON.stringify({ extends: "./.svelte-kit/tsconfig.json" }));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const context = new CompilerContext(root);
      const options = (context as unknown as { readDirectoryOptions(dir: string): unknown }).readDirectoryOptions(path.join(root, "packages", "web"));
      expect(options).toBeDefined();
      (context as unknown as { readDirectoryOptions(dir: string): unknown }).readDirectoryOptions(path.join(root, "packages", "web"));
    } finally {
      cwd.mockRestore();
    }
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain(path.join("packages", "web", "tsconfig.json"));
    expect(messages()[0]).toContain("npx svelte-kit sync");
    expect(messages()[0]).not.toContain("..");
  });

  it("says nothing when the extended file exists", () => {
    fs.writeFileSync(path.join(root, "base.json"), JSON.stringify({ compilerOptions: {} }));
    tsconfig("./base.json");
    new CompilerContext(root);
    expect(warn).not.toHaveBeenCalled();
  });
});
