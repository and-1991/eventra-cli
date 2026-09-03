import { describe, expect, it } from "vitest";
import ts from "typescript";

import { detectJsxEventAttribute } from "../../src/analysis/scanner/jsxEventAttribute";

function findAllNodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function parseJsxAttributes(source: string): ts.JsxAttribute[] {
  const sourceFile = ts.createSourceFile("a.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return findAllNodes(sourceFile, ts.isJsxAttribute);
}

describe("detectJsxEventAttribute", () => {
  it("detects a literal event attribute on a self-closing element", () => {
    const [attribute] = parseJsxAttributes(`const el = <Button event="checkout.cta" />;`);
    const result = detectJsxEventAttribute(attribute);
    expect(result).not.toBeNull();
    expect(result!.calleeText).toBe("Button");
    expect(result!.trackedArguments).toHaveLength(1);
    expect(result!.trackedArguments[0].getText()).toBe('"checkout.cta"');
  });

  it("detects a literal event attribute on a non-self-closing opening element", () => {
    const [attribute] = parseJsxAttributes(`const el = <Button event="checkout.cta">Pay</Button>;`);
    const result = detectJsxEventAttribute(attribute);
    expect(result).not.toBeNull();
    expect(result!.calleeText).toBe("Button");
  });

  it("detects a dynamic event={expr} attribute, raw expression text verbatim", () => {
    const [attribute] = parseJsxAttributes(`const el = <Button event={computedEventName} />;`);
    const result = detectJsxEventAttribute(attribute);
    expect(result).not.toBeNull();
    expect(result!.trackedArguments[0].getText()).toBe("computedEventName");
  });

  it("detects a dynamic property-chain expression", () => {
    const [attribute] = parseJsxAttributes(`const el = <Button event={config.eventName} />;`);
    const result = detectJsxEventAttribute(attribute);
    expect(result!.trackedArguments[0].getText()).toBe("config.eventName");
  });

  it("ignores an attribute not named event", () => {
    const [attribute] = parseJsxAttributes(`const el = <Button disabled="true" />;`);
    expect(detectJsxEventAttribute(attribute)).toBeNull();
  });

  it("ignores the boolean-shorthand event (no initializer)", () => {
    const [attribute] = parseJsxAttributes(`const el = <Button event />;`);
    expect(detectJsxEventAttribute(attribute)).toBeNull();
  });

  it("ignores an empty event={} expression", () => {
    const [attribute] = parseJsxAttributes(`const el = <Button event={} />;`);
    expect(detectJsxEventAttribute(attribute)).toBeNull();
  });

  it("ignores a namespaced attribute name (not a plain identifier)", () => {
    const [attribute] = parseJsxAttributes(`const el = <input xml:event="x" />;`);
    expect(detectJsxEventAttribute(attribute)).toBeNull();
  });

  it("ignores a JSX-element-valued attribute (neither a string literal nor a {expr})", () => {
    const [attribute] = parseJsxAttributes(`const el = <Button event=<span /> />;`);
    expect(detectJsxEventAttribute(attribute)).toBeNull();
  });

  it("returns null for a non-JsxAttribute node", () => {
    const sourceFile = ts.createSourceFile("a.tsx", `const x = 1;`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const [identifier] = findAllNodes(sourceFile, ts.isIdentifier);
    expect(detectJsxEventAttribute(identifier)).toBeNull();
  });

  it("finds the tag name on a component nested inside other JSX", () => {
    const [attribute] = parseJsxAttributes(`
      const el = (
        <div>
          <Button event="nested_button" />
        </div>
      );
    `);
    const result = detectJsxEventAttribute(attribute);
    expect(result!.calleeText).toBe("Button");
  });
});
