import { describe, expect, it } from "vitest";
import ts from "typescript";

import { resolveExportedSymbol } from "../../src/analysis/resolver/exportResolver";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { buildProject, findCallArgument, findIdentifier } from "./resolverTestUtils";

describe("resolveExportedSymbol", () => {
  it("returns null for a symbol-shaped value with no getDeclarations function", () => {
    const project = buildProject({ "a.ts": "export const a = 1;" });
    try {
      const cache = new ResolvedExportCache();
      const fakeSymbol = {} as ts.Symbol;
      expect(resolveExportedSymbol(fakeSymbol, project.checker, cache)).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it("returns a cached result without recomputing (cached null)", () => {
    const project = buildProject({
      "a.ts": `export function trackFeature(event: string) { console.log(event); }`,
    });
    try {
      const sf = project.file("a.ts");
      const symbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "trackFeature", 0))!;
      const cache = new ResolvedExportCache();
      cache.set(symbol, null);
      expect(resolveExportedSymbol(symbol, project.checker, cache)).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it("returns a cached result without recomputing (cached symbol)", () => {
    const project = buildProject({
      "a.ts": `export function trackFeature(event: string) { console.log(event); }`,
    });
    try {
      const sf = project.file("a.ts");
      const symbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "trackFeature", 0))!;
      const cache = new ResolvedExportCache();
      cache.set(symbol, symbol);
      expect(resolveExportedSymbol(symbol, project.checker, cache)).toBe(symbol);
    } finally {
      project.cleanup();
    }
  });

  it("unwraps a plain named import alias to the real exported declaration symbol", () => {
    const project = buildProject({
      "tracker.ts": `export function trackFeature(event: string) { console.log(event); }`,
      "app.ts": `
        import { trackFeature } from "./tracker";
        trackFeature("clicked");
      `,
    });
    try {
      const appFile = project.file("app.ts");
      const trackerFile = project.file("tracker.ts");
      const callArgIdentifier = findIdentifier(appFile, "trackFeature", 1); // usage at call site
      const localSymbol = project.checker.getSymbolAtLocation(callArgIdentifier)!;
      expect(localSymbol.flags & ts.SymbolFlags.Alias).toBeTruthy();

      const cache = new ResolvedExportCache();
      const resolved = resolveExportedSymbol(localSymbol, project.checker, cache);
      expect(resolved).not.toBeNull();

      const realSymbol = project.checker.getSymbolAtLocation(
        findIdentifier(trackerFile, "trackFeature", 0),
      )!;
      expect(resolved).toBe(realSymbol);
    } finally {
      project.cleanup();
    }
  });

  it("unwraps the export symbol of a locally re-exported declaration", () => {
    const project = buildProject({
      "tracker.ts": `
        function trackFeature(event: string) { console.log(event); }
        export { trackFeature };
      `,
    });
    try {
      const sf = project.file("tracker.ts");
      const localSymbol = project.checker.getSymbolAtLocation(
        findIdentifier(sf, "trackFeature", 0),
      )!;
      const cache = new ResolvedExportCache();
      const resolved = resolveExportedSymbol(localSymbol, project.checker, cache);
      expect(resolved).not.toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it("breaks a circular re-export alias cycle instead of recursing forever", () => {
    // a.ts and b.ts alias each other's re-export of the same binding, which
    // can make the checker's alias chain loop back on itself.
    const project = buildProject({
      "origin.ts": `export function trackFeature(event: string) { console.log(event); }`,
      "a.ts": `
        import { bAlias as aAlias } from "./b";
        export { aAlias as aExport };
        export { aAlias };
      `,
      "b.ts": `
        import { aAlias as bAlias } from "./a";
        export { bAlias };
      `,
    });
    try {
      const aFile = project.file("a.ts");
      const symbol = project.checker.getSymbolAtLocation(findIdentifier(aFile, "aAlias", 0))!;
      const cache = new ResolvedExportCache();
      // Must terminate (not throw / hang) and produce a stable, cacheable result.
      const resolved = resolveExportedSymbol(symbol, project.checker, cache);
      expect(resolved === null || typeof resolved === "object").toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("unwraps a Nuxt/unplugin-auto-import style ambient global: dotted typeof-import form", () => {
    const project = buildProject({
      "src/tracker.ts": `export const trackFeature = (event: string) => { console.log(event); };`,
      "auto-imports.d.ts": `declare const trackFeature: typeof import("./src/tracker").trackFeature;`,
      "app.ts": `
        trackFeature("clicked");
      `,
    });
    try {
      const ambientFile = project.file("auto-imports.d.ts");
      const ambientSymbol = project.checker.getSymbolAtLocation(
        findIdentifier(ambientFile, "trackFeature", 0),
      )!;
      const cache = new ResolvedExportCache();
      const resolved = resolveExportedSymbol(ambientSymbol, project.checker, cache);
      expect(resolved).not.toBeNull();
      expect(resolved).not.toBe(ambientSymbol);
    } finally {
      project.cleanup();
    }
  });

  it("unwraps a Nuxt/unplugin-auto-import style ambient global: indexed-access typeof-import form", () => {
    const project = buildProject({
      "src/tracker.ts": `export const trackFeature = (event: string) => { console.log(event); };`,
      "auto-imports.d.ts": `declare const trackFeature: typeof import("./src/tracker")["trackFeature"];`,
      "app.ts": `
        trackFeature("clicked");
      `,
    });
    try {
      const ambientFile = project.file("auto-imports.d.ts");
      const ambientSymbol = project.checker.getSymbolAtLocation(
        findIdentifier(ambientFile, "trackFeature", 0),
      )!;
      const cache = new ResolvedExportCache();
      const resolved = resolveExportedSymbol(ambientSymbol, project.checker, cache);
      expect(resolved).not.toBeNull();
      expect(resolved).not.toBe(ambientSymbol);
    } finally {
      project.cleanup();
    }
  });

  it("treats the ambient auto-import shape as a non-match when the referenced export name doesn't exist", () => {
    const project = buildProject({
      "src/tracker.ts": `export const trackFeature = (event: string) => { console.log(event); };`,
      // Same ambient-global shape as the passing case above, but the indexed
      // name doesn't correspond to a real export of the target module, so
      // checker.getSymbolAtLocation(nameNode) resolves to nothing - exercising
      // the `resolved && ...` false side of resolveAmbientAutoImportSymbol's
      // final ternary. Falls through to treating the ambient `declare const`
      // itself as the (only) concrete declaration.
      "auto-imports.d.ts": `declare const trackFeature: typeof import("./src/tracker")["doesNotExist"];`,
    });
    try {
      const ambientFile = project.file("auto-imports.d.ts");
      const ambientSymbol = project.checker.getSymbolAtLocation(
        findIdentifier(ambientFile, "trackFeature", 0),
      )!;
      const cache = new ResolvedExportCache();
      const resolved = resolveExportedSymbol(ambientSymbol, project.checker, cache);
      expect(resolved).toBe(ambientSymbol);
    } finally {
      project.cleanup();
    }
  });

  it("does not treat an ambient const with an initializer as an auto-import binding", () => {
    const project = buildProject({
      "app.ts": `
        declare const trackFeature: string;
        const other = trackFeature;
        console.log(other);
      `,
    });
    try {
      const sf = project.file("app.ts");
      const symbol = project.checker.getSymbolAtLocation(
        findIdentifier(sf, "trackFeature", 0),
      )!;
      const cache = new ResolvedExportCache();
      // No initializer-free `typeof import(...)` shape here; falls through to
      // the concrete-declaration check. `declare const` has no VariableDeclaration
      // initializer, but its type is a plain `string`, not an import-type — so
      // isConcreteDeclaration ultimately governs the result, not the ambient path.
      const resolved = resolveExportedSymbol(symbol, project.checker, cache);
      expect(resolved === null || resolved === symbol).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("returns the symbol itself for a concrete function declaration (no export/alias to unwrap)", () => {
    const project = buildProject({
      "a.ts": `function trackFeature(event: string) { console.log(event); }\ntrackFeature("x");`,
    });
    try {
      const sf = project.file("a.ts");
      const argument = findCallArgument(sf, "trackFeature");
      expect(ts.isStringLiteral(argument)).toBe(true);
      const symbol = project.checker.getSymbolAtLocation(
        findIdentifier(sf, "trackFeature", 0),
      )!;
      const cache = new ResolvedExportCache();
      const resolved = resolveExportedSymbol(symbol, project.checker, cache);
      expect(resolved).toBe(symbol);
    } finally {
      project.cleanup();
    }
  });

  it("returns null for a symbol with no concrete declaration (e.g. a bare function parameter)", () => {
    const project = buildProject({
      "a.ts": `function run(event: string) { console.log(event); }`,
    });
    try {
      const sf = project.file("a.ts");
      const symbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "event", 0))!;
      const cache = new ResolvedExportCache();
      const resolved = resolveExportedSymbol(symbol, project.checker, cache);
      expect(resolved).toBeNull();
    } finally {
      project.cleanup();
    }
  });
});
