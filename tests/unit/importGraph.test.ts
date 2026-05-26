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
});
