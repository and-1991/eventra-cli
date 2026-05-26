import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DocumentRegistry } from "../../src/compiler/documentRegistry";

describe("DocumentRegistry", () => {
  it("normalizes paths to absolute POSIX form", () => {
    const reg = new DocumentRegistry();
    const cwd = process.cwd().replace(/\\/g, "/");
    expect(reg.normalize("./foo/bar.ts").startsWith(cwd)).toBe(true);
    expect(reg.normalize("./foo/bar.ts").endsWith("/foo/bar.ts")).toBe(true);
  });

  it("starts version at 1 on first update", () => {
    const reg = new DocumentRegistry();
    reg.update("/x.ts", "a");
    expect(reg.getVersion("/x.ts")).toBe("1");
  });

  it("bumps version when content changes", () => {
    const reg = new DocumentRegistry();
    reg.update("/x.ts", "a");
    reg.update("/x.ts", "b");
    reg.update("/x.ts", "c");
    expect(reg.getVersion("/x.ts")).toBe("3");
  });

  it("does not bump version when identical content is written", () => {
    const reg = new DocumentRegistry();
    reg.update("/x.ts", "a");
    reg.update("/x.ts", "a");
    reg.update("/x.ts", "a");
    expect(reg.getVersion("/x.ts")).toBe("1");
  });

  it("returns 0 as version for unknown files", () => {
    const reg = new DocumentRegistry();
    expect(reg.getVersion("/missing.ts")).toBe("0");
  });

  it("has/getContent reflect current state", () => {
    const reg = new DocumentRegistry();
    expect(reg.has("/x.ts")).toBe(false);
    reg.update("/x.ts", "content");
    expect(reg.has("/x.ts")).toBe(true);
    expect(reg.getContent("/x.ts")).toBe("content");
  });

  it("returns a snapshot whose text matches the content", () => {
    const reg = new DocumentRegistry();
    reg.update("/x.ts", "const a = 1;");
    const snap = reg.getSnapshot("/x.ts")!;
    expect(snap.getText(0, snap.getLength())).toBe("const a = 1;");
  });

  it("ensure() reads from disk for unknown files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docregistry-"));
    const file = path.join(tmp, "from-disk.ts");
    fs.writeFileSync(file, "from disk content");

    const reg = new DocumentRegistry();
    reg.ensure(file);
    expect(reg.has(file)).toBe(true);
    expect(reg.getContent(file)).toBe("from disk content");

    fs.unlinkSync(file);
    fs.rmdirSync(tmp);
  });

  it("ensure() is a no-op when file is already registered", () => {
    const reg = new DocumentRegistry();
    reg.update("/x.ts", "in-memory");
    reg.ensure("/x.ts");
    expect(reg.getContent("/x.ts")).toBe("in-memory");
    expect(reg.getVersion("/x.ts")).toBe("1");
  });

  it("ensure() silently skips missing files", () => {
    const reg = new DocumentRegistry();
    expect(() => reg.ensure("/no/such/file.ts")).not.toThrow();
    expect(reg.has("/no/such/file.ts")).toBe(false);
  });

  it("remove() drops a registered file", () => {
    const reg = new DocumentRegistry();
    reg.update("/x.ts", "a");
    reg.remove("/x.ts");
    expect(reg.has("/x.ts")).toBe(false);
  });

  it("getFileNames returns all registered files", () => {
    const reg = new DocumentRegistry();
    reg.update("/a.ts", "a");
    reg.update("/b.ts", "b");
    expect(reg.getFileNames().sort()).toEqual(
      [reg.normalize("/a.ts"), reg.normalize("/b.ts")].sort(),
    );
  });

  it("invalidate() drops everything", () => {
    const reg = new DocumentRegistry();
    reg.update("/a.ts", "a");
    reg.update("/b.ts", "b");
    reg.invalidate();
    expect(reg.getFileNames()).toEqual([]);
  });
});
