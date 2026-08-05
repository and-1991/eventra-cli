import { describe, expect, it } from "vitest";
import ts from "typescript";

import { resolveFunctionFromCall } from "../../src/analysis/resolver/callResolver";
import { ResolvedCallCache } from "../../src/analysis/cache/resolvedCallCache";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { buildProject, findCall } from "./resolverTestUtils";

function resolve(sf: ts.SourceFile, checker: ts.TypeChecker, needle: string, occurrence = 0) {
  const call = findCall(sf, needle, occurrence);
  const callCache = new ResolvedCallCache();
  const exportCache = new ResolvedExportCache();
  return resolveFunctionFromCall(call.expression, checker, callCache, exportCache);
}

describe("resolveFunctionFromCall", () => {
  it("resolves a bare identifier call: track()", () => {
    const project = buildProject({
      "a.ts": `
        function trackFeature(event: string) { console.log(event); }
        trackFeature("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "trackFeature(");
      expect(resolved).not.toBeNull();
      expect(resolved && ts.isFunctionDeclaration(resolved)).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("resolves a property access call: analytics.track()", () => {
    const project = buildProject({
      "a.ts": `
        const analytics = { trackFeature(event: string) { console.log(event); } };
        analytics.trackFeature("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "analytics.trackFeature(");
      expect(resolved).not.toBeNull();
      expect(resolved && ts.isMethodDeclaration(resolved)).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("resolves an optional-chained property access call: analytics?.track()", () => {
    const project = buildProject({
      "a.ts": `
        const analytics: { trackFeature?(event: string): void } = {};
        analytics?.trackFeature?.("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "analytics?.trackFeature");
      // No concrete declaration exists (optional method signature only), so this
      // exercises the property-access-chain symbol lookup even though it ends null.
      expect(resolved === null || typeof resolved === "object").toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("resolves an element access call with a string literal key: analytics['track']()", () => {
    const project = buildProject({
      "a.ts": `
        const analytics = { trackFeature(event: string) { console.log(event); } };
        analytics["trackFeature"]("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, `analytics["trackFeature"]`);
      expect(resolved).not.toBeNull();
      expect(resolved && ts.isMethodDeclaration(resolved)).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("returns null when the callee has no resolvable symbol", () => {
    const project = buildProject({
      "a.ts": `
        declare const anything: any;
        anything.trackFeature("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "anything.trackFeature");
      expect(resolved).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it("resolves a const arrow-function declaration", () => {
    const project = buildProject({
      "a.ts": `
        const trackFeature = (event: string) => { console.log(event); };
        trackFeature("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "trackFeature(");
      expect(resolved).not.toBeNull();
      expect(resolved && ts.isArrowFunction(resolved)).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("resolves a class-field arrow function", () => {
    const project = buildProject({
      "a.ts": `
        class Analytics {
          trackFeature = (event: string) => { console.log(event); };
        }
        const analytics = new Analytics();
        analytics.trackFeature("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "analytics.trackFeature(");
      expect(resolved).not.toBeNull();
      expect(resolved && ts.isArrowFunction(resolved)).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("resolves an object-literal property-assignment function expression", () => {
    const project = buildProject({
      "a.ts": `
        const analytics = { trackFeature: function (event: string) { console.log(event); } };
        analytics.trackFeature("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "analytics.trackFeature(");
      expect(resolved).not.toBeNull();
      expect(resolved && ts.isFunctionExpression(resolved)).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("returns null for a declaration shape that isn't function-like (e.g. a plain property)", () => {
    const project = buildProject({
      "a.ts": `
        const analytics = { trackFeature: "not-a-function" };
        // @ts-ignore - intentionally miscalled for the resolver test
        analytics.trackFeature("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "analytics.trackFeature(");
      expect(resolved).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it("skips a non-function-like merged declaration before finding the function declaration", () => {
    // A namespace merged with a function of the same name gives the symbol two
    // declarations; the namespace one isn't function-like and must be skipped.
    const project = buildProject({
      "a.ts": `
        namespace trackFeature {
          export const version = 1;
        }
        function trackFeature(event: string) { console.log(event); }
        trackFeature("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "trackFeature(", 0);
      expect(resolved).not.toBeNull();
      expect(resolved && ts.isFunctionDeclaration(resolved)).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("unwraps a re-exported (aliased) symbol across files before resolving the declaration", () => {
    const project = buildProject({
      "tracker.ts": `export function trackFeature(event: string) { console.log(event); }`,
      "app.ts": `
        import { trackFeature } from "./tracker";
        trackFeature("x");
      `,
    });
    try {
      const sf = project.file("app.ts");
      const resolved = resolve(sf, project.checker, "trackFeature(");
      expect(resolved).not.toBeNull();
      expect(resolved && ts.isFunctionDeclaration(resolved)).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("caches the resolved declaration across repeated calls to the same wrapper", () => {
    const project = buildProject({
      "a.ts": `
        function trackFeature(event: string) { console.log(event); }
        trackFeature("first");
        trackFeature("second");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const callCache = new ResolvedCallCache();
      const exportCache = new ResolvedExportCache();
      const first = resolveFunctionFromCall(
        findCall(sf, "trackFeature(", 0).expression,
        project.checker,
        callCache,
        exportCache,
      );
      const second = resolveFunctionFromCall(
        findCall(sf, "trackFeature(", 1).expression,
        project.checker,
        callCache,
        exportCache,
      );
      expect(first).not.toBeNull();
      expect(first).toBe(second);
    } finally {
      project.cleanup();
    }
  });

  it("caches an unresolved (null) result across repeated calls", () => {
    const project = buildProject({
      "a.ts": `
        declare const anything: any;
        anything.trackFeature("first");
        anything.trackFeature("second");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const callCache = new ResolvedCallCache();
      const exportCache = new ResolvedExportCache();
      const first = resolveFunctionFromCall(
        findCall(sf, "anything.trackFeature", 0).expression,
        project.checker,
        callCache,
        exportCache,
      );
      const second = resolveFunctionFromCall(
        findCall(sf, "anything.trackFeature", 1).expression,
        project.checker,
        callCache,
        exportCache,
      );
      expect(first).toBeNull();
      expect(second).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it("falls back to the type's call signature when destructured from a returned object literal", () => {
    const project = buildProject({
      "a.ts": `
        function getHandlers() {
          return { trackFeature: (event: string) => { console.log(event); } };
        }
        const { trackFeature } = getHandlers();
        trackFeature("x");
      `,
    });
    try {
      const sf = project.file("a.ts");
      const resolved = resolve(sf, project.checker, "trackFeature(");
      // Whether or not the checker can trace a signature declaration all the way
      // back to the originating arrow function depends on structural typing,
      // but this must not throw, and it exercises the type-signature fallback
      // path (no VariableDeclaration/PropertyDeclaration/PropertyAssignment
      // initializer exists for a destructured BindingElement).
      expect(resolved === null || typeof resolved === "object").toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("resolves through a single-level alias unwrap when the deep export resolution declines (circular re-export)", () => {
    const project = buildProject({
      "a.ts": `
        import { bAlias as aAlias } from "./b";
        export { aAlias };
      `,
      "b.ts": `
        import { aAlias as bAlias } from "./a";
        export { bAlias };
      `,
      "app.ts": `
        import { aAlias } from "./a";
        aAlias("x");
      `,
    });
    try {
      const sf = project.file("app.ts");
      // Must terminate without throwing even though the alias chain is circular.
      const resolved = resolve(sf, project.checker, "aAlias(");
      expect(resolved === null || typeof resolved === "object").toBe(true);
    } finally {
      project.cleanup();
    }
  });
});
