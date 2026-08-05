import { describe, expect, it } from "vitest";
import { ImportGraph } from "../../src/compiler/importGraph";

describe("ImportGraph", () => {
  it("records forward and reverse edges", () => {
    const g = new ImportGraph();
    g.updateFile("/a.ts", ["/b.ts", "/c.ts"]);
    g.updateFile("/b.ts", ["/c.ts"]);

    expect([...g.collectDependents("/c.ts")].sort()).toEqual([
      "/a.ts",
      "/b.ts",
      "/c.ts",
    ]);
    expect([...g.collectDependents("/b.ts")].sort()).toEqual([
      "/a.ts",
      "/b.ts",
    ]);
    expect([...g.collectDependents("/a.ts")]).toEqual(["/a.ts"]);
  });

  it("removes stale edges when imports change", () => {
    const g = new ImportGraph();
    g.updateFile("/a.ts", ["/old.ts"]);
    expect([...g.collectDependents("/old.ts")].sort()).toEqual([
      "/a.ts",
      "/old.ts",
    ]);

    g.updateFile("/a.ts", ["/new.ts"]);
    // /old.ts should no longer have /a.ts as an importer
    expect([...g.collectDependents("/old.ts")]).toEqual(["/old.ts"]);
    expect([...g.collectDependents("/new.ts")].sort()).toEqual([
      "/a.ts",
      "/new.ts",
    ]);
  });

  it("transitively walks importers", () => {
    const g = new ImportGraph();
    g.updateFile("/a.ts", ["/b.ts"]);
    g.updateFile("/b.ts", ["/c.ts"]);
    g.updateFile("/c.ts", ["/d.ts"]);

    expect([...g.collectDependents("/d.ts")].sort()).toEqual([
      "/a.ts",
      "/b.ts",
      "/c.ts",
      "/d.ts",
    ]);
  });

  it("does not loop on cycles", () => {
    const g = new ImportGraph();
    g.updateFile("/a.ts", ["/b.ts"]);
    g.updateFile("/b.ts", ["/a.ts"]);

    const dependents = g.collectDependents("/a.ts");
    expect(dependents.has("/a.ts")).toBe(true);
    expect(dependents.has("/b.ts")).toBe(true);
    expect(dependents.size).toBe(2);
  });

  it("removeFile drops both forward and reverse edges", () => {
    const g = new ImportGraph();
    g.updateFile("/a.ts", ["/b.ts"]);
    g.updateFile("/c.ts", ["/a.ts"]);

    g.removeFile("/a.ts");

    // /b.ts no longer reachable from /a.ts (a is gone)
    expect([...g.collectDependents("/b.ts")]).toEqual(["/b.ts"]);
    // /c.ts had /a.ts as a dep, but the edge is cleared
    expect([...g.collectDependents("/a.ts")]).toEqual(["/a.ts"]);
    expect([...g.collectDependents("/c.ts")]).toEqual(["/c.ts"]);
  });

  it("keeps an edge untouched when the same import persists across an update", () => {
    const g = new ImportGraph();
    g.updateFile("/a.ts", ["/b.ts", "/c.ts"]);
    // /b.ts persists, /c.ts is dropped, /d.ts is added
    g.updateFile("/a.ts", ["/b.ts", "/d.ts"]);

    expect([...g.collectDependents("/b.ts")].sort()).toEqual(["/a.ts", "/b.ts"]);
    expect([...g.collectDependents("/c.ts")]).toEqual(["/c.ts"]);
    expect([...g.collectDependents("/d.ts")].sort()).toEqual(["/a.ts", "/d.ts"]);
  });

  it("removeFile on a file that was never passed to updateFile is a no-op", () => {
    const g = new ImportGraph();
    expect(() => g.removeFile("/never-seen.ts")).not.toThrow();
    expect([...g.collectDependents("/never-seen.ts")]).toEqual(["/never-seen.ts"]);
  });

  it("tolerates a reverse edge that was already cleared by removing the import target first", () => {
    const g = new ImportGraph();
    g.updateFile("/a.ts", ["/x.ts"]);
    // Removing the import target directly clears reverse.get("/x.ts") entirely,
    // while /a.ts's own forward-import record ("/x.ts") is untouched.
    g.removeFile("/x.ts");

    // updateFile now looks up a reverse entry for "/x.ts" that no longer exists.
    expect(() => g.updateFile("/a.ts", [])).not.toThrow();

    g.updateFile("/b.ts", ["/y.ts"]);
    g.removeFile("/y.ts");
    // removeFile("/b.ts") now looks up a reverse entry for "/y.ts" that's gone too.
    expect(() => g.removeFile("/b.ts")).not.toThrow();
  });

  it("keeps the reverse edge when another importer still references the target", () => {
    const g = new ImportGraph();
    g.updateFile("/a.ts", ["/shared.ts"]);
    g.updateFile("/b.ts", ["/shared.ts"]);

    // /a.ts drops the import; /b.ts still references /shared.ts, so the
    // reverse edge must survive (size stays > 0, no delete).
    g.updateFile("/a.ts", []);
    expect([...g.collectDependents("/shared.ts")].sort()).toEqual(["/b.ts", "/shared.ts"]);

    g.updateFile("/c.ts", ["/shared2.ts"]);
    g.updateFile("/d.ts", ["/shared2.ts"]);
    // removeFile("/c.ts") removes only its own importer entry; /d.ts remains.
    g.removeFile("/c.ts");
    expect([...g.collectDependents("/shared2.ts")].sort()).toEqual(["/d.ts", "/shared2.ts"]);
  });
});
