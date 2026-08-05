import { describe, expect, it } from "vitest";
import ts from "typescript";

import { DynamicOccurrence, recordDynamicOccurrence } from "../../src/analysis/shared/dynamicOccurrence";

function findFirstCall(source: string): ts.CallExpression {
  const sourceFile = ts.createSourceFile("test.ts", source, ts.ScriptTarget.ESNext, true);
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (!found && ts.isCallExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) {
    throw new Error("no call expression found in fixture source");
  }
  return found;
}

describe("recordDynamicOccurrence", () => {
  it("records position, callee text, and resolved values for a short call", () => {
    const call = findFirstCall(`sdk.track(eventName);`);
    const out: DynamicOccurrence[] = [];

    recordDynamicOccurrence(call, ["maybe_a", "maybe_b"], out);

    expect(out).toHaveLength(1);
    const [occurrence] = out;
    expect(occurrence.fileName).toBe("test.ts");
    expect(occurrence.line).toBe(1);
    expect(occurrence.character).toBe(0);
    expect(occurrence.calleeText).toBe("sdk.track");
    expect(occurrence.callText).toBe("sdk.track(eventName)");
    expect(occurrence.resolvedValues).toEqual(["maybe_a", "maybe_b"]);
  });

  it("truncates call text longer than the max length and appends an ellipsis", () => {
    const longArgument = `"${"x".repeat(150)}"`;
    const call = findFirstCall(`sdk.track(${longArgument});`);
    const out: DynamicOccurrence[] = [];

    recordDynamicOccurrence(call, [], out);

    const [occurrence] = out;
    expect(occurrence.callText.length).toBe(121);
    expect(occurrence.callText.endsWith("…")).toBe(true);
    expect(occurrence.callText.startsWith(`sdk.track("${"x".repeat(108)}`)).toBe(true);
  });

  it("appends to an existing occurrences array without clearing it", () => {
    const call = findFirstCall(`sdk.track(name);`);
    const existing: DynamicOccurrence = {
      fileName: "other.ts",
      line: 5,
      character: 2,
      calleeText: "other.track",
      callText: "other.track(name)",
      resolvedValues: [],
    };
    const out: DynamicOccurrence[] = [existing];

    recordDynamicOccurrence(call, ["name_value"], out);

    expect(out).toHaveLength(2);
    expect(out[0]).toBe(existing);
    expect(out[1].calleeText).toBe("sdk.track");
  });
});
