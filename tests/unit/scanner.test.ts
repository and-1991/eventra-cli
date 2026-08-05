import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { scanSource } from "../../src/analysis/scanner/scanner";
import { WrapperRegistry } from "../../src/analysis/symbols/wrapperRegistry";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { PluginRegistry } from "../../src/plugin/registry";
import type { SinkDetector, WrapperDetector } from "../../src/plugin/types";
import type { TrackSink } from "../../src/analysis/shared/propagation";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function findFunctionDeclaration(root: ts.Node, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error(`function ${name} not found`);
  return found;
}

/** A test-only sink detector recognizing a handful of made-up callee names,
 * each chosen to drive a distinct branch inside scanSource's tracked-argument
 * resolution (missing argument, property-path hit/miss on an object literal,
 * property-path on a non-object argument, and no property path at all) —
 * without needing to route through the real @eventra_dev/eventra-sdk type
 * checks that the built-in detector requires. */
const testSinkDetector: SinkDetector = {
  name: "test-sink",
  detect({ call }) {
    if (!ts.isIdentifier(call.expression)) {
      return null;
    }
    switch (call.expression.text) {
      case "trackSimple":
        return { call, trackedArguments: [{ index: 0, propertyPath: [] }] };
      case "trackMissing":
        return { call, trackedArguments: [{ index: 0, propertyPath: [] }] };
      case "trackProp":
        return { call, trackedArguments: [{ index: 0, propertyPath: ["event"] }] };
      case "trackPropMissing":
        return { call, trackedArguments: [{ index: 0, propertyPath: ["event"] }] };
      case "trackNonObjectPropertyPath":
        return { call, trackedArguments: [{ index: 0, propertyPath: ["event"] }] };
      case "trackObjectNoPath":
        return { call, trackedArguments: [{ index: 0, propertyPath: [] }] };
      default:
        return null;
    }
  },
};

function setup(source: string, extraDetectors: SinkDetector[] = [], wrapperDetectors: WrapperDetector[] = []) {
  const { root, cleanup } = makeProject();
  const ctx = new CompilerContext(root);
  const file = path.join(root, "a.ts");
  ctx.updateFile(file, source);
  const checker = ctx.getChecker();
  const sourceFile = ctx.getSourceFile(file)!;
  const plugins = new PluginRegistry();
  plugins.registerSinkDetector(testSinkDetector);
  for (const detector of extraDetectors) {
    plugins.registerSinkDetector(detector);
  }
  for (const detector of wrapperDetectors) {
    plugins.registerWrapperDetector(detector);
  }
  const wrapperRegistry = new WrapperRegistry(checker, new ResolvedExportCache());
  return { root, cleanup, checker, sourceFile, plugins, wrapperRegistry };
}

describe("scanSource", () => {
  it("resolves tracked arguments across every propertyPath / object-literal combination", () => {
    const { cleanup, checker, sourceFile, plugins, wrapperRegistry } = setup(`
      const event = "shorthand_value";

      function useTrackers() {
        trackSimple("simple_event");
        trackMissing();
        trackProp({ event: "prop_event", other: 1 });
        trackPropMissing({ other: "x" });
        trackNonObjectPropertyPath("non_object");
        trackObjectNoPath({ event: "whole_object" });
        console.log("not a sink");
      }
    `);
    try {
      const index = scanSource(sourceFile, checker, wrapperRegistry, plugins);

      // console.log is not recognized by the sink detector.
      expect(index.sinks).toHaveLength(6);

      const byCallee = new Map(
        index.trackCalls.map((call) => [call.node.expression.getText(), call]),
      );

      // track(name) — no property path, argument returned as-is.
      expect(byCallee.get("trackSimple")?.trackedArguments[0].getText()).toBe('"simple_event"');

      // missing argument is filtered out of trackedArguments entirely.
      expect(byCallee.get("trackMissing")?.trackedArguments).toHaveLength(0);

      // track({ event: name }) — property found, resolves to its initializer.
      expect(byCallee.get("trackProp")?.trackedArguments[0].getText()).toBe('"prop_event"');

      // propertyPath given but the property isn't present — falls back to
      // returning the whole object literal.
      const propMissingArg = byCallee.get("trackPropMissing")?.trackedArguments[0];
      expect(propMissingArg && ts.isObjectLiteralExpression(propMissingArg)).toBe(true);

      // propertyPath given but the argument isn't an object literal at all —
      // returns the argument itself.
      expect(byCallee.get("trackNonObjectPropertyPath")?.trackedArguments[0].getText()).toBe('"non_object"');

      // no propertyPath — the whole object literal is returned, unresolved.
      const noPathArg = byCallee.get("trackObjectNoPath")?.trackedArguments[0];
      expect(noPathArg && ts.isObjectLiteralExpression(noPathArg)).toBe(true);

      // functions are collected and semantically analyzed for wrapper info;
      // useTrackers has no parameters that any tracked argument resolves to,
      // so it is not registered as a wrapper.
      expect(index.wrappers.some((w) => w.declaration === findFunctionDeclaration(sourceFile, "useTrackers"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("scopes local sinks to their enclosing function and detects a real parameter-propagating wrapper", () => {
    const { cleanup, checker, sourceFile, plugins, wrapperRegistry } = setup(`
      function wrapperFn(name) {
        trackSimple(name);
      }
      trackSimple("top_level_event");
    `);
    try {
      const index = scanSource(sourceFile, checker, wrapperRegistry, plugins);
      const wrapperFnDecl = findFunctionDeclaration(sourceFile, "wrapperFn");
      const wrapper = index.wrappers.find((w) => w.declaration === wrapperFnDecl);
      expect(wrapper).toBeDefined();
      expect(wrapper?.propagations).toHaveLength(1);
      expect(wrapper?.propagations[0].sourceParameterIndex).toBe(0);

      // the registry should be populated with the same wrapper the index reports.
      expect(wrapperRegistry.get(wrapperFnDecl)).toBe(wrapper);
    } finally {
      cleanup();
    }
  });

  it("prefers a plugin-provided wrapper over the built-in analyzer", () => {
    const wrapperDetector: WrapperDetector = {
      name: "custom-wrapper",
      detect({ fn, checker }) {
        if (!ts.isFunctionDeclaration(fn) || fn.name?.text !== "customWrapper") {
          return null;
        }
        const symbol = checker.getSymbolAtLocation(fn.name);
        if (!symbol) {
          return null;
        }
        return { symbol, declaration: fn, propagations: [] };
      },
    };
    const { cleanup, checker, sourceFile, plugins, wrapperRegistry } = setup(
      `
      function customWrapper(payload) {
        trackSimple("marker_event_for_custom_wrapper");
      }
    `,
      [],
      [wrapperDetector],
    );
    try {
      const index = scanSource(sourceFile, checker, wrapperRegistry, plugins);
      const decl = findFunctionDeclaration(sourceFile, "customWrapper");
      const wrapper = index.wrappers.find((w) => w.declaration === decl);
      expect(wrapper).toBeDefined();
      // the built-in analyzer would have found zero propagations too (the
      // tracked argument is a string literal, not an identifier), so an
      // empty propagations array here only proves the plugin's object won,
      // not that the fallback silently ran instead.
      expect(wrapper?.propagations).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("skips function declarations with no body (ambient / overload signatures)", () => {
    const { cleanup, checker, sourceFile, plugins, wrapperRegistry } = setup(`
      declare function overloadFn(x: string): void;
    `);
    try {
      const index = scanSource(sourceFile, checker, wrapperRegistry, plugins);
      expect(index.wrappers).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("skips import and export declarations without descending into them", () => {
    const { root, cleanup } = makeProject();
    try {
      const otherFile = path.join(root, "other.ts");
      fs.writeFileSync(otherFile, `export const untracked = "value";`);
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        import { untracked } from "./other";
        export * from "./other";

        trackSimple("after_imports");
      `,
      );
      const checker = ctx.getChecker();
      const sourceFile = ctx.getSourceFile(file)!;
      const plugins = new PluginRegistry();
      plugins.registerSinkDetector(testSinkDetector);
      const wrapperRegistry = new WrapperRegistry(checker, new ResolvedExportCache());
      const index = scanSource(sourceFile, checker, wrapperRegistry, plugins);
      expect(index.sinks).toHaveLength(1);
      expect(index.trackCalls[0].node.expression.getText()).toBe("trackSimple");
    } finally {
      cleanup();
    }
  });
});
