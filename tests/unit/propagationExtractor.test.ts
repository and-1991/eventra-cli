import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { extractPropagationEvents } from "../../src/analysis/extractor/propagationExtractor";
import { WrapperRegistry } from "../../src/analysis/symbols/wrapperRegistry";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { ResolvedCallCache } from "../../src/analysis/cache/resolvedCallCache";
import { ReturnPropagationCache } from "../../src/analysis/cache/returnPropagationCache";
import { EvaluationCache } from "../../src/analysis/cache/evaluationCache";
import { DynamicOccurrence } from "../../src/analysis/shared/dynamicOccurrence";
import { WrapperPropagation } from "../../src/analysis/shared/propagation";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propagation-extractor-"));
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

function findCall(root: ts.Node, calleeName: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error(`call to ${calleeName} not found`);
  return found;
}

/** First identifier with the given text found within `root` (DFS). */
function findIdentifier(root: ts.Node, text: string): ts.Identifier {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === text) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error(`identifier "${text}" not found`);
  return found;
}

function setup(source: string) {
  const { root, cleanup } = makeProject();
  const ctx = new CompilerContext(root);
  const file = path.join(root, "a.ts");
  ctx.updateFile(file, source);
  const checker = ctx.getChecker();
  const sourceFile = ctx.getSourceFile(file)!;
  const wrapperRegistry = new WrapperRegistry(checker, new ResolvedExportCache());
  return {
    cleanup,
    checker,
    sourceFile,
    wrapperRegistry,
    resolvedCallCache: new ResolvedCallCache(),
    returnPropagationCache: new ReturnPropagationCache(),
    evaluationCache: new EvaluationCache(),
    exportCache: new ResolvedExportCache(),
  };
}

function extract(
  env: ReturnType<typeof setup>,
  call: ts.CallExpression,
  events: Set<string>,
  visited: Set<ts.Signature>,
  dynamicOccurrences: DynamicOccurrence[],
): void {
  extractPropagationEvents(
    call,
    env.checker,
    env.wrapperRegistry,
    env.resolvedCallCache,
    env.returnPropagationCache,
    env.evaluationCache,
    env.exportCache,
    events,
    visited,
    dynamicOccurrences,
  );
}

function registerWrapper(env: ReturnType<typeof setup>, fnName: string, propagations: readonly WrapperPropagation[]): ts.FunctionDeclaration {
  const decl = findFunctionDeclaration(env.sourceFile, fnName);
  const symbol = env.checker.getSymbolAtLocation(decl.name!)!;
  env.wrapperRegistry.set({ symbol, declaration: decl, propagations });
  return decl;
}

describe("extractPropagationEvents", () => {
  it("does nothing when the call site's callee can't be resolved to a function declaration", () => {
    const env = setup(`undeclaredFn(1);`);
    try {
      const call = findCall(env.sourceFile, "undeclaredFn");
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("does nothing when the resolved function isn't a registered wrapper", () => {
    const env = setup(`
      function plainFn(x) { return x; }
      plainFn(1);
    `);
    try {
      const call = findCall(env.sourceFile, "plainFn");
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("skips re-entrant extraction once a signature is already being visited", () => {
    const env = setup(`
      function wrapperVisited(payload) {}
      wrapperVisited("should_not_appear_when_visited");
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperVisited");
      const paramName = (decl.parameters[0].name as ts.Identifier);
      registerWrapper(env, "wrapperVisited", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: [],
          targetNode: paramName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperVisited");
      const signature = env.checker.getSignatureFromDeclaration(decl)!;

      // Sanity check: without the guard, this setup does resolve the event.
      const eventsWithoutGuard = new Set<string>();
      extract(env, call, eventsWithoutGuard, new Set(), []);
      expect(eventsWithoutGuard.has("should_not_appear_when_visited")).toBe(true);

      // With the signature already marked visited, extraction must bail out.
      const eventsWithGuard = new Set<string>();
      const visited = new Set<ts.Signature>([signature]);
      extract(env, call, eventsWithGuard, visited, []);
      expect(eventsWithGuard.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("skips a propagation whose source parameter index has no argument at the call site", () => {
    const env = setup(`
      function wrapperMissingArg(payload) {}
      wrapperMissingArg();
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperMissingArg");
      const paramName = decl.parameters[0].name as ts.Identifier;
      registerWrapper(env, "wrapperMissingArg", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: [],
          targetNode: paramName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperMissingArg");
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("resolves an identifier-parameter propagation to a literal value", () => {
    const env = setup(`
      function wrapperIdentifier(payload) {}
      wrapperIdentifier("valid_event");
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperIdentifier");
      const paramName = decl.parameters[0].name as ts.Identifier;
      registerWrapper(env, "wrapperIdentifier", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: [],
          targetNode: paramName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperIdentifier");
      const events = new Set<string>();
      const dynamicOccurrences: DynamicOccurrence[] = [];
      extract(env, call, events, new Set(), dynamicOccurrences);
      expect(events.has("valid_event")).toBe(true);
      expect(dynamicOccurrences).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });

  it("skips a resolved value that fails event-name normalization", () => {
    const env = setup(`
      function wrapperIdentifierInvalid(payload) {}
      wrapperIdentifierInvalid("invalid event!");
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperIdentifierInvalid");
      const paramName = decl.parameters[0].name as ts.Identifier;
      registerWrapper(env, "wrapperIdentifierInvalid", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: [],
          targetNode: paramName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperIdentifierInvalid");
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("records a dynamic occurrence when the propagated value can't be resolved to a plain literal", () => {
    const env = setup(`
      declare const unknownX: string;
      function wrapperIdentifierDynamic(payload) {}
      wrapperIdentifierDynamic(\`prefix-\${unknownX}\`);
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperIdentifierDynamic");
      const paramName = decl.parameters[0].name as ts.Identifier;
      registerWrapper(env, "wrapperIdentifierDynamic", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: [],
          targetNode: paramName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperIdentifierDynamic");
      const events = new Set<string>();
      const dynamicOccurrences: DynamicOccurrence[] = [];
      extract(env, call, events, new Set(), dynamicOccurrences);
      expect(dynamicOccurrences).toHaveLength(1);
      expect(dynamicOccurrences[0].calleeText).toBe("wrapperIdentifierDynamic");
    } finally {
      env.cleanup();
    }
  });

  it("returns early for a destructured source parameter with an empty propertyPath", () => {
    const env = setup(`
      function wrapperDestructureEmptyPath({ event }) {}
      wrapperDestructureEmptyPath({ event: "ignored" });
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperDestructureEmptyPath");
      const pattern = decl.parameters[0].name as ts.ObjectBindingPattern;
      const eventBindingName = pattern.elements[0].name as ts.Identifier;
      registerWrapper(env, "wrapperDestructureEmptyPath", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          // A real plugin-provided propagation could omit the property path;
          // extractPropagation must bail out rather than mis-resolve it.
          propertyPath: [],
          targetNode: eventBindingName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperDestructureEmptyPath");
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("returns early for a destructured source parameter whose targetNode isn't an identifier", () => {
    const env = setup(`
      function wrapperDestructureNonIdentTarget({ event }) {}
      wrapperDestructureNonIdentTarget({ event: "ignored2" });
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperDestructureNonIdentTarget");
      const call = findCall(env.sourceFile, "wrapperDestructureNonIdentTarget");
      registerWrapper(env, "wrapperDestructureNonIdentTarget", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: ["event"],
          // A non-identifier targetNode (here, the call's own object-literal
          // argument) must be rejected before any resolution is attempted.
          targetNode: call.arguments[0],
        },
      ]);
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("returns early when the property path doesn't resolve on the call-site object literal", () => {
    const env = setup(`
      function wrapperDestructureMissingKey({ event }) {}
      wrapperDestructureMissingKey({ other: "x", extra: "y" });
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperDestructureMissingKey");
      const pattern = decl.parameters[0].name as ts.ObjectBindingPattern;
      const eventBindingName = pattern.elements[0].name as ts.Identifier;
      registerWrapper(env, "wrapperDestructureMissingKey", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: ["event"],
          targetNode: eventBindingName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperDestructureMissingKey");
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("returns early when the property path walks through a non-object value", () => {
    const env = setup(`
      function wrapperDestructureThroughNonObject({ event }) {}
      wrapperDestructureThroughNonObject({ meta: "not_an_object" });
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperDestructureThroughNonObject");
      const pattern = decl.parameters[0].name as ts.ObjectBindingPattern;
      const eventBindingName = pattern.elements[0].name as ts.Identifier;
      registerWrapper(env, "wrapperDestructureThroughNonObject", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: ["meta", "event"],
          targetNode: eventBindingName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperDestructureThroughNonObject");
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("returns early when the destructured targetNode has no binding symbol (an undeclared reference)", () => {
    const env = setup(`
      function wrapperDestructureNoBindingSymbol({ event }) {}
      wrapperDestructureNoBindingSymbol({ event: "value_for_missing_binding" });
      function useUndeclaredRef() {
        return undeclaredBindingRef;
      }
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperDestructureNoBindingSymbol");
      // A real, parsed (but undeclared) identifier reference — the TS binder
      // never assigns it a symbol, so getSymbolAtLocation legitimately
      // returns undefined for it, exactly like a plugin-built targetNode
      // that doesn't correspond to any real binding.
      const undeclaredRef = findIdentifier(env.sourceFile, "undeclaredBindingRef");
      registerWrapper(env, "wrapperDestructureNoBindingSymbol", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: ["event"],
          targetNode: undeclaredRef,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperDestructureNoBindingSymbol");
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.size).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("walks the property path through a spread, a non-identifier (numeric) key, and a nested object down to a shorthand match", () => {
    const env = setup(`
      const spreadStuff = {};
      const event = "shorthand_meta_value";
      function wrapperDestructureShorthand({ event }) {}
      wrapperDestructureShorthand({ ...spreadStuff, 42: "num_value", meta: { "otherKey": "nope", event } });
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperDestructureShorthand");
      const pattern = decl.parameters[0].name as ts.ObjectBindingPattern;
      const eventBindingName = pattern.elements[0].name as ts.Identifier;
      registerWrapper(env, "wrapperDestructureShorthand", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: ["meta", "event"],
          targetNode: eventBindingName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperDestructureShorthand");
      const events = new Set<string>();
      const dynamicOccurrences: DynamicOccurrence[] = [];
      extract(env, call, events, new Set(), dynamicOccurrences);
      // resolveObjectPath successfully walks meta -> event and matches the
      // shorthand property, but a shorthand's own symbol (a synthetic object
      // -literal member) has no variable-declaration/enum-member to unwrap
      // further, so the value stays unresolved (dynamic, no literal) rather
      // than following the shorthand back to the outer `event` constant.
      expect(events.size).toBe(0);
      expect(dynamicOccurrences).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });

  it("resolves a full property path (spread, numeric key, nested object, quoted key) down to a real literal", () => {
    const env = setup(`
      const spreadStuff = {};
      function wrapperDestructureNestedLiteral({ event }) {}
      wrapperDestructureNestedLiteral({ ...spreadStuff, 42: "num_value", meta: { "otherKey": "nope", "event": "nested_literal_value" } });
    `);
    try {
      const decl = findFunctionDeclaration(env.sourceFile, "wrapperDestructureNestedLiteral");
      const pattern = decl.parameters[0].name as ts.ObjectBindingPattern;
      const eventBindingName = pattern.elements[0].name as ts.Identifier;
      registerWrapper(env, "wrapperDestructureNestedLiteral", [
        {
          sourceParameter: decl.parameters[0],
          sourceParameterIndex: 0,
          propertyPath: ["meta", "event"],
          targetNode: eventBindingName,
        },
      ]);
      const call = findCall(env.sourceFile, "wrapperDestructureNestedLiteral");
      const events = new Set<string>();
      extract(env, call, events, new Set(), []);
      expect(events.has("nested_literal_value")).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});
