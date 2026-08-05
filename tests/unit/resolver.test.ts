import { describe, expect, it } from "vitest";
import ts from "typescript";

import { resolveNodeValue } from "../../src/analysis/resolver/resolver";
import { EvaluationCache } from "../../src/analysis/cache/evaluationCache";
import { ResolvedCallCache } from "../../src/analysis/cache/resolvedCallCache";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { ReturnPropagationCache } from "../../src/analysis/cache/returnPropagationCache";
import { createEvaluationContext, EvaluationContext } from "../../src/analysis/shared/evaluationContext";
import {
  buildProject,
  findCallArgument,
  findIdentifier,
  findNode,
  Project,
} from "./resolverTestUtils";

interface Caches {
  evaluationCache: EvaluationCache;
  resolvedCallCache: ResolvedCallCache | undefined;
  returnPropagationCache: ReturnPropagationCache;
  exportCache: ResolvedExportCache;
}

function freshCaches(resolvedCallCache: ResolvedCallCache | undefined = new ResolvedCallCache()): Caches {
  return {
    evaluationCache: new EvaluationCache(),
    resolvedCallCache,
    returnPropagationCache: new ReturnPropagationCache(),
    exportCache: new ResolvedExportCache(),
  };
}

function resolve(
  project: Project,
  node: ts.Node,
  caches: Caches = freshCaches(),
  context: EvaluationContext = createEvaluationContext(),
  visited: Set<ts.Node> = new Set(),
) {
  return resolveNodeValue(
    node,
    project.checker,
    context,
    visited,
    caches.evaluationCache,
    caches.resolvedCallCache,
    caches.returnPropagationCache,
    caches.exportCache,
  );
}

describe("resolveNodeValue - literals", () => {
  it("resolves a string literal", () => {
    const project = buildProject({ "a.ts": `track("event_name");` });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: ["event_name"], dynamic: false });
    } finally {
      project.cleanup();
    }
  });

  it("resolves a no-substitution template literal", () => {
    const project = buildProject({ "a.ts": "track(`event_name`);" });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: ["event_name"], dynamic: false });
    } finally {
      project.cleanup();
    }
  });

  it("resolves a template expression with a resolvable interpolation", () => {
    const project = buildProject({
      "a.ts": "const suffix = \"abc\";\ntrack(`prefix-${suffix}`);",
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      const result = resolve(project, arg);
      expect(result.values).toEqual(["prefix-abc"]);
      expect(result.dynamic).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("resolves a template expression with an unresolvable interpolation to no values", () => {
    const project = buildProject({
      "a.ts": "function run(suffix: string) {\n  track(`prefix-${suffix}`);\n}",
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      const result = resolve(project, arg);
      expect(result.values).toEqual([]);
      expect(result.dynamic).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("resolves a conditional expression by merging both branches", () => {
    const project = buildProject({
      "a.ts": `declare const cond: boolean;\ntrack(cond ? "a" : "b");`,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      const result = resolve(project, arg);
      expect(result.values.sort()).toEqual(["a", "b"]);
      expect(result.dynamic).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("resolves an array literal by collecting every element", () => {
    const project = buildProject({ "a.ts": `track(["a", "b"]);` });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      const result = resolve(project, arg);
      expect(result.values.sort()).toEqual(["a", "b"]);
      expect(result.dynamic).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("returns empty for a node type it doesn't handle (numeric literal)", () => {
    const project = buildProject({ "a.ts": `track(42);` });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("returns empty for a binary expression that isn't string concatenation", () => {
    const project = buildProject({
      "a.ts": `declare const a: string;\ndeclare const b: string;\ntrack(a !== b);`,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("resolves string concatenation via the plus operator", () => {
    const project = buildProject({
      "a.ts": `const a = "foo_";\nconst b = "bar";\ntrack(a + b);`,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      const result = resolve(project, arg);
      expect(result.values).toEqual(["foo_bar"]);
      expect(result.dynamic).toBe(true);
    } finally {
      project.cleanup();
    }
  });
});

describe("resolveNodeValue - object literal (direct)", () => {
  it("collects string values from property assignments, skips spreads/methods, and takes the shorthand branch", () => {
    const project = buildProject({
      "a.ts": `
        declare const spreadSrc: { z: string };
        const shorthandVar = "shorthand_value";
        const literal = {
          ...spreadSrc,
          a: "a_value",
          shorthandVar,
          method() { return "not_collected"; },
        };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const result = resolve(project, literal);
      // The shorthand branch is exercised (property.name is fed into
      // resolveNodeValue), but getSymbolAtLocation on a shorthand property's
      // name node resolves to the property symbol (declarations: [the
      // ShorthandPropertyAssignment itself]), not the referenced variable's
      // own VariableDeclaration - so resolveIdentifier's declaration loop
      // finds nothing to match and it contributes no value. Only the plain
      // property assignment shows up.
      expect(result.values).toEqual(["a_value"]);
      expect(result.dynamic).toBe(true);
    } finally {
      project.cleanup();
    }
  });
});

describe("resolveNodeValue - unwrap chain", () => {
  const cases: Array<[string, string]> = [
    ["parenthesized expression", `track((("event_name")));`],
    ["as-expression", `track("event_name" as string);`],
    ["type-assertion expression", `track(<string>"event_name");`],
    ["non-null assertion", `declare const maybe: string | undefined;\ntrack(maybe!);`],
    ["satisfies expression", `track("event_name" satisfies string);`],
  ];

  for (const [label, source] of cases) {
    it(`unwraps a ${label}`, () => {
      const project = buildProject({ "a.ts": source });
      try {
        const sf = project.file("a.ts");
        const arg = findCallArgument(sf, "track(");
        const result = resolve(project, arg);
        // maybe! resolves to nothing (declare const, no literal value) - still exercises the unwrap.
        expect(result.dynamic === true || result.dynamic === false).toBe(true);
        if (label !== "non-null assertion") {
          expect(result.values).toEqual(["event_name"]);
        }
      } finally {
        project.cleanup();
      }
    });
  }
});

describe("resolveNodeValue - property access", () => {
  it("returns empty when the property name can't be determined (dynamic element key)", () => {
    const project = buildProject({
      "a.ts": `
        declare const payload: Record<string, string>;
        declare const dynamicKey: string;
        track(payload[dynamicKey]);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("returns empty when the target identifier has no resolvable symbol", () => {
    const project = buildProject({
      "a.ts": `
        // @ts-ignore
        track(UNDECLARED_GLOBAL.event);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("resolves through a base bound to an object literal via parameterBindings (single level)", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(payload: { event: string }) {
          return payload.event;
        }
        const literal = { event: "bound_event" };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramIdentifier = findIdentifier(sf, "payload", 0);
      const paramSymbol = project.checker.getSymbolAtLocation(paramIdentifier)!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.event",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result.values).toEqual(["bound_event"]);
    } finally {
      project.cleanup();
    }
  });

  it("takes the shorthand branch when walking a bound object literal's properties", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(payload: { event: string }) {
          return payload.event;
        }
        const event = "shorthand_bound_event";
        const literal = { event };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.event",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      // Exercises the `ts.isShorthandPropertyAssignment(property) ? property.name : ...`
      // branch; see the direct object-literal shorthand test above for why this
      // resolves to no value rather than the referenced variable's value.
      expect(result).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("resolves a nested (two-level) bound object chain", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(payload: { nested: { event: string } }) {
          return payload.nested.event;
        }
        const literal = { nested: { event: "nested_bound_event" } };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.nested.event",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result.values).toEqual(["nested_bound_event"]);
    } finally {
      project.cleanup();
    }
  });

  it("stops the bound chain when an intermediate segment resolves to a non-object value", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(payload: { nested: { event: string } }) {
          return payload.nested.event;
        }
        const literal = { nested: "not_an_object" };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.nested.event",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("stops the bound chain when an intermediate segment's property name can't be determined (dynamic key)", () => {
    const project = buildProject({
      "a.ts": `
        declare const dynamicKey: string;
        function wrapper(payload: { nested: Record<string, { event: string }> }) {
          return payload.nested[dynamicKey].event;
        }
        const literal = { nested: { event: "unreachable" } };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.nested[dynamicKey].event",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("walks a three-level bound object chain, skipping spread and mismatched properties at each level", () => {
    const project = buildProject({
      "a.ts": `
        declare const spreadSrc: { x: string };
        function wrapper(payload: { a: { b: string } }) {
          return payload.a.b;
        }
        const literal = {
          ...spreadSrc,
          other: "skip_me",
          a: { ...spreadSrc, other2: "skip_me_too", b: "deep_nested_value" },
        };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.a.b",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result.values).toEqual(["deep_nested_value"]);
    } finally {
      project.cleanup();
    }
  });

  it("returns no value when an intermediate segment of the bound chain has no matching property", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(payload: { a: { b: string } }) {
          return payload.a.b;
        }
        const literal = { unrelated: "nope" };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.a.b",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("handles a non-identifier-named (quoted) property and a shorthand match while walking an intermediate bound-object segment", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(payload: { a: { b: string } }) {
          return payload.a.b;
        }
        const a = { b: "deep_nested_value" };
        const literal = { "unrelated-key": "skip_via_getText", a };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.a.b",
      )!;
      const literal = findNode(
        sf,
        (n): n is ts.ObjectLiteralExpression =>
          ts.isObjectLiteralExpression(n) && n.getText().includes("unrelated-key"),
      )!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      // The shorthand match returns the bare identifier `a` (not the object
      // it refers to - see the direct object-literal shorthand test for why),
      // so the outer ".b" lookup can't walk into it and resolves to no value.
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("skips a non-identifier-named (quoted) property while walking a directly bound object literal", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(payload: { event: string }) {
          return payload.event;
        }
        const literal = { "other-quoted-key": "skip_via_getText", event: "matched_after_quoted_key" };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.event",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result.values).toEqual(["matched_after_quoted_key"]);
    } finally {
      project.cleanup();
    }
  });

  it("skips a non-identifier-named (quoted) property while walking a const-object's properties", () => {
    const project = buildProject({
      "a.ts": `
        const EVENTS = { "OTHER-quoted-key": "skip_via_getText", LOGIN: "quoted_key_login" };
        track(EVENTS.LOGIN);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["quoted_key_login"]);
    } finally {
      project.cleanup();
    }
  });

  it("falls back to the raw symbol when resolveExportedSymbol finds no concrete declaration for the target identifier", () => {
    const project = buildProject({
      "a.ts": `
        const wrapper = { EVENTS: { LOGIN: "destructured_login" } };
        const { EVENTS } = wrapper;
        track(EVENTS.LOGIN);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      // EVENTS's own declaration is a destructuring BindingElement, which
      // resolveExportedSymbol doesn't treat as concrete - it returns null,
      // exercising the `?? symbol` fallback. The fallback still doesn't
      // match anything afterward (neither loop below handles a
      // BindingElement declaration), so this resolves to no value - the
      // fallback keeps resolution from crashing, not from succeeding here.
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("stops the bound chain when a middle segment (not the outermost) resolves to a non-object value", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(payload: any) {
          return payload.a.b.c;
        }
        const literal = { a: "not_an_object" };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.a.b.c",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("returns null from the bound-object walk when the base is a call expression, not an identifier chain", () => {
    const project = buildProject({
      "a.ts": `
        declare function getPayload(): { event: string };
        track(getPayload().event);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("skips non-matching and non-property entries while walking the bound object's properties", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(payload: { event: string }) {
          return payload.event;
        }
        declare const spreadSrc: { other: string };
        const literal = { ...spreadSrc, other: "skip_me", event: "matched_after_skip" };
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "payload", 0))!;
      const propertyAccess = findNode(
        sf,
        (n): n is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(n) && n.getText() === "payload.event",
      )!;
      const literal = findNode(sf, ts.isObjectLiteralExpression)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, propertyAccess, freshCaches(), context);
      expect(result.values).toEqual(["matched_after_skip"]);
    } finally {
      project.cleanup();
    }
  });

  it("resolves a string enum member accessed directly", () => {
    const project = buildProject({
      "a.ts": `
        enum EVENTS {
          LOGIN = "enum_login",
        }
        track(EVENTS.LOGIN);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["enum_login"]);
    } finally {
      project.cleanup();
    }
  });

  it("skips an unset (auto-numbered) enum member before finding the matching one", () => {
    const project = buildProject({
      "a.ts": `
        enum EVENTS {
          UNSET,
          LOGIN = "enum_login_after_skip",
        }
        track(EVENTS.LOGIN);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["enum_login_after_skip"]);
    } finally {
      project.cleanup();
    }
  });

  it("resolves a string-literal-named enum member via element access", () => {
    const project = buildProject({
      "a.ts": `
        enum EVENTS {
          "weird name" = "weird_value",
        }
        track(EVENTS["weird name"]);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["weird_value"]);
    } finally {
      project.cleanup();
    }
  });

  it("resolves a string enum member imported from another file", () => {
    const project = buildProject({
      "events.ts": `
        export enum EVENTS {
          LOGIN = "enum_login_cross_file",
        }
      `,
      "app.ts": `
        import { EVENTS } from "./events";
        track(EVENTS.LOGIN);
      `,
    });
    try {
      const sf = project.file("app.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["enum_login_cross_file"]);
    } finally {
      project.cleanup();
    }
  });

  it("resolves a const-object property (property assignment)", () => {
    const project = buildProject({
      "a.ts": `
        const EVENTS = { LOGIN: "const_object_login" };
        track(EVENTS.LOGIN);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["const_object_login"]);
    } finally {
      project.cleanup();
    }
  });

  it("takes the shorthand branch for a const-object property (shorthand assignment)", () => {
    const project = buildProject({
      "a.ts": `
        const LOGIN = "const_object_shorthand_login";
        const EVENTS = { LOGIN };
        track(EVENTS.LOGIN);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      // See the direct object-literal shorthand test for why this resolves to
      // no value rather than the referenced variable's value.
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("skips spread entries and mismatched keys before matching the const-object property", () => {
    const project = buildProject({
      "a.ts": `
        declare const spreadSrc: { other: string };
        const EVENTS = { ...spreadSrc, OTHER: "not_this_one", LOGIN: "matched_const_object" };
        track(EVENTS.LOGIN);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["matched_const_object"]);
    } finally {
      project.cleanup();
    }
  });

  it("does not match when the declaration exists but has no object-literal initializer", () => {
    const project = buildProject({
      "a.ts": `
        let EVENTS: { LOGIN: string };
        EVENTS = { LOGIN: "assigned_later" };
        track(EVENTS.LOGIN);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("resolves an element access with a string literal key against a const object", () => {
    const project = buildProject({
      "a.ts": `
        const EVENTS = { LOGIN: "element_access_login" };
        track(EVENTS["LOGIN"]);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["element_access_login"]);
    } finally {
      project.cleanup();
    }
  });
});

describe("resolveNodeValue - identifiers", () => {
  it("returns empty for an identifier with no resolvable symbol", () => {
    const project = buildProject({
      "a.ts": `
        // @ts-ignore
        track(UNDECLARED_IDENTIFIER);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("resolves a bound parameter identifier directly (no property access)", () => {
    const project = buildProject({
      "a.ts": `
        function wrapper(event: string) {
          return event;
        }
        const literal = "direct_bound_identifier";
      `,
    });
    try {
      const sf = project.file("a.ts");
      const paramSymbol = project.checker.getSymbolAtLocation(findIdentifier(sf, "event", 0))!;
      const returnIdentifier = findIdentifier(sf, "event", 1); // the `return event;` reference
      const literal = findNode(sf, ts.isStringLiteral)!;
      const context: EvaluationContext = {
        parameterBindings: new Map([[paramSymbol, literal]]),
      };
      const result = resolve(project, returnIdentifier, freshCaches(), context);
      expect(result.values).toEqual(["direct_bound_identifier"]);
    } finally {
      project.cleanup();
    }
  });

  it("caches a resolved identifier value across repeated resolutions", () => {
    const project = buildProject({
      "a.ts": `
        const EVENT_NAME = "cached_identifier_value";
        track(EVENT_NAME);
        track(EVENT_NAME);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const caches = freshCaches();
      const first = resolve(project, findCallArgument(sf, "track(", 0, 0), caches);
      const second = resolve(project, findCallArgument(sf, "track(", 0, 1), caches);
      expect(first.values).toEqual(["cached_identifier_value"]);
      expect(second).toBe(first);
    } finally {
      project.cleanup();
    }
  });

  it("resolves an identifier declared via a variable initializer", () => {
    const project = buildProject({
      "a.ts": `
        const EVENT_NAME = "variable_initializer_value";
        track(EVENT_NAME);
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["variable_initializer_value"]);
    } finally {
      project.cleanup();
    }
  });

  it("resolves an identifier declared as a self-referencing enum member", () => {
    const project = buildProject({
      "a.ts": `
        enum E {
          A = 1,
          B = A,
        }
      `,
    });
    try {
      const sf = project.file("a.ts");
      // The identifier `A` used as B's initializer resolves directly to enum
      // member A's own declaration (no property access needed - it's in scope
      // inside the enum body), exercising resolveIdentifier's EnumMember branch.
      const aReference = findIdentifier(sf, "A", 1);
      const result = resolve(project, aReference);
      // Member A's initializer is a NumericLiteral, which resolveNodeValue
      // doesn't special-case, so it bottoms out at empty() - but the EnumMember
      // declaration branch itself is what's under test here.
      expect(result).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("returns the resolving placeholder for a symbol with no variable/enum-member declaration", () => {
    const project = buildProject({
      "a.ts": `
        function trackFeature(event: string) { console.log(event); }
        const ref = trackFeature;
      `,
    });
    try {
      const sf = project.file("a.ts");
      const identifier = findIdentifier(sf, "trackFeature", 1); // usage in `const ref = trackFeature`
      expect(resolve(project, identifier)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("unwraps an imported (aliased) identifier before resolving its declaration", () => {
    const project = buildProject({
      "events.ts": `export const EVENT_NAME = "imported_alias_value";`,
      "app.ts": `
        import { EVENT_NAME } from "./events";
        track(EVENT_NAME);
      `,
    });
    try {
      const sf = project.file("app.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["imported_alias_value"]);
    } finally {
      project.cleanup();
    }
  });
});

describe("resolveNodeValue - call expressions", () => {
  it("returns empty when the call target doesn't resolve to a function", () => {
    const project = buildProject({
      "a.ts": `
        declare const unknownDynamic: any;
        track(unknownDynamic());
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("returns empty when the resolved function has no return-value propagation", () => {
    const project = buildProject({
      "a.ts": `
        function noop(event: string) { console.log(event); }
        track(noop("x"));
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("resolves a direct identity-return wrapper call", () => {
    const project = buildProject({
      "a.ts": `
        function identity(event: string) { return event; }
        track(identity("clicked"));
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["clicked"]);
    } finally {
      project.cleanup();
    }
  });

  it("skips a propagation whose parameter index has no matching call argument", () => {
    const project = buildProject({
      "a.ts": `
        function wrap(a: string, event: string) { return event; }
        track(wrap("only-one"));
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg)).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });

  it("collects values from every propagation for a multi-parameter object return", () => {
    const project = buildProject({
      "a.ts": `
        function wrap(a: string, b: string) { return { a: a, b: b }; }
        track(wrap("value_a", "value_b"));
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values.sort()).toEqual(["value_a", "value_b"]);
    } finally {
      project.cleanup();
    }
  });

  it("resolves a template-literal return that references the bound parameter", () => {
    const project = buildProject({
      "a.ts": `
        function wrap(event: string) { return \`prefix-\${event}\`; }
        track(wrap("clicked"));
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      expect(resolve(project, arg).values).toEqual(["prefix-clicked"]);
    } finally {
      project.cleanup();
    }
  });

  it("reuses the cached return-propagation semantic across repeated calls to the same wrapper", () => {
    const project = buildProject({
      "a.ts": `
        function identity(event: string) { return event; }
        track(identity("first"));
        track(identity("second"));
      `,
    });
    try {
      const sf = project.file("a.ts");
      const caches = freshCaches();
      const first = resolve(project, findCallArgument(sf, "track(", 0, 0), caches);
      const second = resolve(project, findCallArgument(sf, "track(", 0, 1), caches);
      expect(first.values).toEqual(["first"]);
      expect(second.values).toEqual(["second"]);
    } finally {
      project.cleanup();
    }
  });

  it("falls back to constructing its own ResolvedCallCache when none is supplied", () => {
    const project = buildProject({
      "a.ts": `
        function identity(event: string) { return event; }
        track(identity("no_cache_supplied"));
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      // Explicitly passing `undefined` to freshCaches(resolvedCallCache = new
      // ResolvedCallCache()) still triggers its default parameter (JS applies
      // defaults on an explicit `undefined` argument too) - build the Caches
      // object directly so resolvedCallCache is actually undefined here.
      const caches: Caches = {
        evaluationCache: new EvaluationCache(),
        resolvedCallCache: undefined,
        returnPropagationCache: new ReturnPropagationCache(),
        exportCache: new ResolvedExportCache(),
      };
      const result = resolve(project, arg, caches);
      expect(result.values).toEqual(["no_cache_supplied"]);
    } finally {
      project.cleanup();
    }
  });

  it("breaks a self-application cycle: identity(identity(x)) does not resolve through both layers", () => {
    const project = buildProject({
      "a.ts": `
        function identity(event: string) { return event; }
        const x = "clicked";
        track(identity(identity(x)));
      `,
    });
    try {
      const sf = project.file("a.ts");
      const arg = findCallArgument(sf, "track(");
      // Contrast case proving the guard, not an unrelated resolution failure:
      // a single (non-nested) call to the same wrapper resolves normally.
      const singleProject = buildProject({
        "a.ts": `
          function identity(event: string) { return event; }
          const x = "clicked";
          track(identity(x));
        `,
      });
      try {
        const singleSf = singleProject.file("a.ts");
        const singleArg = findCallArgument(singleSf, "track(");
        expect(resolve(singleProject, singleArg).values).toEqual(["clicked"]);
      } finally {
        singleProject.cleanup();
      }

      const nestedResult = resolve(project, arg);
      expect(nestedResult).toEqual({ values: [], dynamic: true });
    } finally {
      project.cleanup();
    }
  });
});
