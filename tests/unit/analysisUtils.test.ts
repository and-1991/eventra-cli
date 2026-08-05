import { describe, expect, it } from "vitest";
import ts from "typescript";

import {
  getCallName,
  getFunctionName,
  getPropertyName,
  unwrapExpression,
} from "../../src/analysis/shared/utils";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function findNode<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T {
  let found: T | undefined;
  const visit = (node: ts.Node) => {
    if (!found && predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) {
    throw new Error("node not found in fixture source");
  }
  return found;
}

function firstCallArgument(source: string): ts.Expression {
  const sourceFile = parse(source);
  const call = findNode(sourceFile, ts.isCallExpression);
  return call.arguments[0];
}

describe("unwrapExpression", () => {
  it("returns the same node when there is nothing to unwrap", () => {
    const arg = firstCallArgument(`track(eventName);`);
    expect(unwrapExpression(arg)).toBe(arg);
  });

  it("unwraps a parenthesized expression", () => {
    const arg = firstCallArgument(`track((eventName));`);
    const unwrapped = unwrapExpression(arg);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
    expect((unwrapped as ts.Identifier).text).toBe("eventName");
  });

  it("unwraps a non-null assertion", () => {
    const arg = firstCallArgument(`track(eventName!);`);
    const unwrapped = unwrapExpression(arg);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
  });

  it("unwraps an `as` expression", () => {
    const arg = firstCallArgument(`track(eventName as string);`);
    const unwrapped = unwrapExpression(arg);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
  });

  it("unwraps an angle-bracket type assertion", () => {
    const arg = firstCallArgument(`track(<string>eventName);`);
    const unwrapped = unwrapExpression(arg);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
  });

  it("unwraps a `satisfies` expression", () => {
    const arg = firstCallArgument(`track(eventName satisfies string);`);
    const unwrapped = unwrapExpression(arg);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
  });

  it("unwraps a chain of nested wrappers down to the underlying expression", () => {
    const arg = firstCallArgument(`track((((eventName!) as string)));`);
    const unwrapped = unwrapExpression(arg);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
    expect((unwrapped as ts.Identifier).text).toBe("eventName");
  });
});

describe("getPropertyName", () => {
  it("reads the name off a property access expression", () => {
    const sourceFile = parse(`payload.event;`);
    const node = findNode(sourceFile, ts.isPropertyAccessExpression);
    expect(getPropertyName(node)).toBe("event");
  });

  it("reads the name off an optional-chain property access", () => {
    const sourceFile = parse(`payload?.event;`);
    const node = findNode(sourceFile, ts.isPropertyAccessExpression);
    expect(getPropertyName(node)).toBe("event");
  });

  it("reads a string-literal element access as the property name", () => {
    const sourceFile = parse(`payload["event"];`);
    const node = findNode(sourceFile, ts.isElementAccessExpression);
    expect(getPropertyName(node)).toBe("event");
  });

  it("returns null for a non-string-literal element access", () => {
    const sourceFile = parse(`payload[index];`);
    const node = findNode(sourceFile, ts.isElementAccessExpression);
    expect(getPropertyName(node)).toBeNull();
  });

  it("returns null for a numeric element access", () => {
    const sourceFile = parse(`payload[0];`);
    const node = findNode(sourceFile, ts.isElementAccessExpression);
    expect(getPropertyName(node)).toBeNull();
  });
});

describe("getCallName", () => {
  it("reads a bare identifier callee", () => {
    const sourceFile = parse(`track();`);
    const call = findNode(sourceFile, ts.isCallExpression);
    expect(getCallName(call.expression)).toBe("track");
  });

  it("reads a property-access callee", () => {
    const sourceFile = parse(`analytics.track();`);
    const call = findNode(sourceFile, ts.isCallExpression);
    expect(getCallName(call.expression)).toBe("track");
  });

  it("reads an optional-chain property-access callee", () => {
    const sourceFile = parse(`analytics?.track();`);
    const call = findNode(sourceFile, ts.isCallExpression);
    expect(getCallName(call.expression)).toBe("track");
  });

  it("returns an empty string for any other callee shape", () => {
    const sourceFile = parse(`analytics["track"]();`);
    const call = findNode(sourceFile, ts.isCallExpression);
    expect(getCallName(call.expression)).toBe("");
  });
});

describe("getFunctionName", () => {
  it("reads the name off a named function declaration", () => {
    const sourceFile = parse(`function trackFeature() {}`);
    const node = findNode(sourceFile, ts.isFunctionDeclaration);
    expect(getFunctionName(node)).toBe("trackFeature");
  });

  it("falls back to anonymous for an unnamed function declaration", () => {
    const sourceFile = parse(`export default function () {}`);
    const node = findNode(sourceFile, ts.isFunctionDeclaration);
    expect(getFunctionName(node)).toBe("anonymous");
  });

  it("reads the name off a class method with an identifier name", () => {
    const sourceFile = parse(`class Service { run() {} }`);
    const node = findNode(sourceFile, ts.isMethodDeclaration);
    expect(getFunctionName(node)).toBe("run");
  });

  it("falls back to anonymous for a computed method name", () => {
    const sourceFile = parse(`class Service { [Symbol.iterator]() {} }`);
    const node = findNode(sourceFile, ts.isMethodDeclaration);
    expect(getFunctionName(node)).toBe("anonymous");
  });

  it("reads the variable name for an arrow function assigned via const", () => {
    const sourceFile = parse(`const trackFeature = () => {};`);
    const node = findNode(sourceFile, ts.isArrowFunction);
    expect(getFunctionName(node)).toBe("trackFeature");
  });

  it("falls back to anonymous when the variable declaration name is a destructuring pattern", () => {
    const sourceFile = parse(`const [trackFeature] = [(() => {})];`);
    const node = findNode(sourceFile, ts.isArrowFunction);
    expect(getFunctionName(node)).toBe("anonymous");
  });

  it("reads the field name for a class field initialized with an arrow function", () => {
    const sourceFile = parse(`class Service { trackFeature = () => {}; }`);
    const node = findNode(sourceFile, ts.isArrowFunction);
    expect(getFunctionName(node)).toBe("trackFeature");
  });

  it("falls back to anonymous when the class field name is computed", () => {
    const sourceFile = parse(`class Service { [computedName] = () => {}; }`);
    const node = findNode(sourceFile, ts.isArrowFunction);
    expect(getFunctionName(node)).toBe("anonymous");
  });

  it("falls back to anonymous for an arrow function exported as the default with no other binding", () => {
    const sourceFile = parse(`export default () => {};`);
    const node = findNode(sourceFile, ts.isArrowFunction);
    expect(ts.isExportAssignment(node.parent)).toBe(true);
    expect(getFunctionName(node)).toBe("anonymous");
  });

  it("falls back to anonymous for a function with no matching parent shape", () => {
    const sourceFile = parse(`let handler; handler = function () {};`);
    const node = findNode(sourceFile, ts.isFunctionExpression);
    expect(getFunctionName(node)).toBe("anonymous");
  });
});
