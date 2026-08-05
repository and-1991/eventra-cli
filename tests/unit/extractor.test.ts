import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { extractEvents } from "../../src/analysis/extractor/extractor";
import { EvaluationCache } from "../../src/analysis/cache/evaluationCache";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { ResolvedCallCache } from "../../src/analysis/cache/resolvedCallCache";
import { ReturnPropagationCache } from "../../src/analysis/cache/returnPropagationCache";
import { WrapperRegistry } from "../../src/analysis/symbols/wrapperRegistry";
import { FileSemanticIndex } from "../../src/analysis/shared/types";
import { EventraConfig } from "../../src/types";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extractor-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const CONFIG: EventraConfig = {
  apiKey: "",
  events: [],
  functionWrappers: [],
  sync: {
    include: ["**/*.ts"],
    exclude: [],
  },
};

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

describe("extractEvents", () => {
  it("adds normalized values, skips invalid ones, and records dynamic occurrences", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        declare const helperVar: string;
        function sink(...args: unknown[]): void {}
        sink("valid_event", "invalid event!", \`dynamic-\${helperVar}\`);
      `,
      );
      const checker = ctx.getChecker();
      const sourceFile = ctx.getSourceFile(file)!;
      const call = findCall(sourceFile, "sink");

      const index: FileSemanticIndex = {
        fileName: file,
        sourceFile,
        sinks: [],
        wrappers: [],
        trackCalls: [
          {
            node: call,
            sourceFile,
            trackedArguments: [call.arguments[0], call.arguments[1], call.arguments[2]],
          },
        ],
      };

      const wrapperRegistry = new WrapperRegistry(checker, new ResolvedExportCache());
      const result = extractEvents(
        index,
        checker,
        CONFIG,
        new EvaluationCache(),
        new ResolvedExportCache(),
        new ResolvedCallCache(),
        new ReturnPropagationCache(),
        wrapperRegistry,
      );

      expect(result.events.has("valid_event")).toBe(true);
      // fails normalizeEventName's charset check (space, "!") — must be skipped.
      expect(result.events.has("invalid event!")).toBe(false);
      // the template literal resolves dynamically (an unresolved identifier
      // span), so it must be recorded as a dynamic occurrence.
      expect(result.dynamicOccurrences).toHaveLength(1);
      expect(result.dynamicOccurrences[0].calleeText).toBe("sink");
      expect(result.detectedFunctionWrappers.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("summarizes detected function wrappers by symbol name", () => {
    const { root, cleanup } = makeProject();
    try {
      const ctx = new CompilerContext(root);
      const file = path.join(root, "a.ts");
      ctx.updateFile(
        file,
        `
        function trackWrapper(name) {}
      `,
      );
      const checker = ctx.getChecker();
      const sourceFile = ctx.getSourceFile(file)!;

      let found: ts.FunctionDeclaration | undefined;
      ts.forEachChild(sourceFile, function visit(node) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "trackWrapper") {
          found = node;
        }
        ts.forEachChild(node, visit);
      });
      const fn = found!;
      const symbol = checker.getSymbolAtLocation(fn.name!)!;

      const index: FileSemanticIndex = {
        fileName: file,
        sourceFile,
        sinks: [],
        trackCalls: [],
        wrappers: [
          {
            symbol,
            declaration: fn,
            propagations: [],
          },
        ],
      };

      const wrapperRegistry = new WrapperRegistry(checker, new ResolvedExportCache());
      const result = extractEvents(
        index,
        checker,
        CONFIG,
        new EvaluationCache(),
        new ResolvedExportCache(),
        new ResolvedCallCache(),
        new ReturnPropagationCache(),
        wrapperRegistry,
      );

      expect(result.detectedFunctionWrappers).toEqual(new Set(["trackWrapper"]));
    } finally {
      cleanup();
    }
  });
});
