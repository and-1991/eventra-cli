// src/analysis/shared/dynamicOccurrence.ts

import ts from "typescript";

/** A track() call site whose event-name argument could not be resolved to a plain string literal. */
export interface DynamicOccurrence {
  readonly fileName: string;
  readonly line: number;
  readonly character: number;
  readonly calleeText: string;
  readonly callText: string;
  readonly resolvedValues: readonly string[];
}

const CALL_TEXT_MAX_LENGTH = 120;

// `node` is a CallExpression for a real track() call, or a JsxAttribute for
// a JSX `event="..."`/`event={expr}` binding (see jsxEventAttribute.ts) -
// `calleeText` is supplied by the caller since it's derived differently per
// node kind (a call's callee text vs. a JSX element's tag name).
export function recordDynamicOccurrence(node: ts.Node, calleeText: string, resolvedValues: readonly string[], out: DynamicOccurrence[]): void {
  const sourceFile = node.getSourceFile();
  const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  const callText = node.getText(sourceFile);
  out.push({
    fileName: sourceFile.fileName,
    line: line + 1,
    character,
    calleeText,
    callText: callText.length > CALL_TEXT_MAX_LENGTH ? `${callText.slice(0, CALL_TEXT_MAX_LENGTH)}…` : callText,
    resolvedValues,
  });
}
